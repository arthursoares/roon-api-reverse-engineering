/**
 * RemotingClient — ported from Sooloos.Broker.Remoting.RemotingClientV2.
 *
 * Sits on top of a Transport (raw frames) and provides:
 *  - getService(guid)            -> object id of a service
 *  - callMethod(oid, name, args) -> result bytes (resolves on final response)
 *  - DEFMETHOD bookkeeping: a method's signature string is declared to the
 *    server (cmd 6) the first time we use its locally-assigned method id.
 *  - request/response correlation by request id.
 *
 * Inbound requests (server pushes: PUSHOBJ/UPDATEOBJ/DEFTYPE/PING…) are handed
 * to onPush; the object-graph reader consumes those to locate service objects.
 */
import { Frame, FrameParser, encodeRequest, encodeResponse } from './frame';
import { BinaryWriter } from './writer';
import { readFlexLong } from './flex';

export const Cmd = {
  PING: 1,
  GETSVC: 2,
  CALL: 3,
  GCOBJS: 4,
  DEFTYPE: 5,
  DEFMETHOD: 6,
  SENDMSG: 7,
} as const;

export interface Transport {
  send(data: Buffer): void;
  /** Register a handler for raw inbound bytes. */
  onData(handler: (chunk: Buffer) => void): void;
}

export interface CallResult {
  /** status string from the server; 'Success' (or empty) means OK. */
  status: string;
  /** true when the call succeeded. */
  success: boolean;
  /** remaining response bytes after the status string (the return value). */
  payload: Buffer;
}

/** The server reports success with the literal status string "Success". */
export function isSuccessStatus(status: string): boolean {
  return status === 'Success' || status === '';
}

interface Pending {
  chunks: Buffer[];
  resolve: (r: Frame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RemotingClient {
  private parser = new FrameParser();
  private ridCounter = 0;
  private methodNameToId = new Map<string, number>();
  private nextMethodId = 1;
  private definedMethods = new Set<number>();
  private pending = new Map<number, Pending>();

  /** Called with every inbound request frame (server push). */
  onPush: (frame: Frame) => void = () => {};

  constructor(
    private transport: Transport,
    private requestTimeoutMs = 15000
  ) {
    transport.onData((chunk) => {
      for (const frame of this.parser.push(chunk)) this.handleFrame(frame);
    });
  }

  private nextRid(): number {
    this.ridCounter = (this.ridCounter + 1) & 0x7fffffff;
    return this.ridCounter;
  }

  /** Get (assigning if new) the local method id for a signature string. */
  methodId(signature: string): number {
    let id = this.methodNameToId.get(signature);
    if (id === undefined) {
      id = this.nextMethodId++;
      this.methodNameToId.set(signature, id);
    }
    return id;
  }

  /** DEFMETHOD on first use: declare (methodId, signature) to the server. */
  private ensureDefined(methodId: number, signature: string): void {
    if (this.definedMethods.has(methodId)) return;
    this.definedMethods.add(methodId);
    const body = new BinaryWriter().flexInt(methodId).string(signature).toBuffer();
    this.transport.send(encodeRequest(Cmd.DEFMETHOD, body, null));
  }

  // Client-declared value types (for by-value struct args). Separate id space
  // from method ids; the server keys its _remote_types by our declared id.
  private clientTypeIds = new Map<string, number>();
  private nextClientTypeId = 1;
  private declaredTypes = new Set<number>();

  /**
   * Declare a client value type to the server (DEFTYPE, cmd 5) on first use and
   * return its client-assigned type id. `members` may be a subset (or empty) —
   * the server maps each member by name; absent members default. Ported from
   * RemotingClientV2._WriteTypeId.
   */
  defineType(typeName: string, members: { name: string; propType: number }[] = []): number {
    let id = this.clientTypeIds.get(typeName);
    if (id === undefined) {
      id = this.nextClientTypeId++;
      this.clientTypeIds.set(typeName, id);
    }
    if (!this.declaredTypes.has(id)) {
      this.declaredTypes.add(id);
      const w = new BinaryWriter().flexInt(id).string(typeName).flexInt(members.length);
      for (const m of members) w.string(m.name).integer(m.propType);
      this.transport.send(encodeRequest(Cmd.DEFTYPE, w.toBuffer(), null));
    }
    return id;
  }

  /** Low-level: send a request that expects a response; resolves with the final frame. */
  private request(cmd: number, body: Buffer): Promise<Frame> {
    const rid = this.nextRid();
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`remoting request ${rid} (cmd ${cmd}) timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(rid, { chunks: [], resolve, reject, timer });
      this.transport.send(encodeRequest(cmd, body, rid));
    });
  }

  /**
   * Call a method on an object. `signature` is the full DEFMETHOD string
   * (build with formatMethodSignature). `args` is the pre-serialized argument
   * block. Returns the parsed status + return-value bytes.
   */
  async callMethod(objectId: bigint | number, signature: string, args: Buffer): Promise<CallResult> {
    const mid = this.methodId(signature);
    this.ensureDefined(mid, signature);
    const body = new BinaryWriter().long(objectId).flexInt(mid).bytes(args).toBuffer();
    const frame = await this.request(Cmd.CALL, body);
    return this.parseCallResult(frame.body);
  }

  /** Fire-and-forget call (no ResultCallback param). */
  callMethodNoReply(objectId: bigint | number, signature: string, args: Buffer): void {
    const mid = this.methodId(signature);
    this.ensureDefined(mid, signature);
    const body = new BinaryWriter().long(objectId).flexInt(mid).bytes(args).toBuffer();
    this.transport.send(encodeRequest(Cmd.CALL, body, null));
  }

  /** GETSVC: resolve a service GUID to its object id. */
  async getService(guid16: Uint8Array): Promise<bigint> {
    const body = new BinaryWriter().guid(guid16).toBuffer();
    const frame = await this.request(Cmd.GETSVC, body);
    // response = string(status) + flexLong(objectId)
    const res = this.parseCallResult(frame.body);
    if (!res.success) throw new Error(`getService failed: ${res.status}`);
    const [oid] = readFlexLong(Uint8Array.from(res.payload), 0);
    return oid;
  }

  /** A response body begins with a status string ('' = Success). */
  private parseCallResult(body: Buffer): CallResult {
    const u = Uint8Array.from(body);
    // string = flexInt(len) then bytes; len -1 (0xFFFFFFFF) means null.
    let pos = 0;
    let num = 0;
    for (;;) {
      const b = u[pos++];
      num = (num << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    const len = num >>> 0;
    let status = '';
    if (len === 0xffffffff) {
      status = '';
    } else {
      status = Buffer.from(u.subarray(pos, pos + len)).toString('utf8');
      pos += len;
    }
    return { status, success: isSuccessStatus(status), payload: Buffer.from(u.subarray(pos)) };
  }

  private handleFrame(frame: Frame): void {
    if (frame.isResponse) {
      const p = frame.rid !== null ? this.pending.get(frame.rid) : undefined;
      if (!p) return; // unknown/late response
      p.chunks.push(frame.body);
      if (frame.isFinal) {
        clearTimeout(p.timer);
        this.pending.delete(frame.rid!);
        const joined =
          p.chunks.length === 1 ? frame.body : Buffer.concat([...p.chunks]);
        p.resolve({ ...frame, body: joined });
      }
      return;
    }
    // Inbound request from the server.
    if (frame.cmd === Cmd.PING) {
      // reply to keep-alive: empty final response to the ping's rid
      if (frame.rid !== null) this.transport.send(encodeResponse(frame.rid, Buffer.alloc(0)));
      return;
    }
    this.onPush(frame);
    // Requests that expect a response (rid present) must be acked.
    if (frame.rid !== null && frame.cmd !== Cmd.PING) {
      this.transport.send(encodeResponse(frame.rid, Buffer.alloc(0)));
    }
  }
}
