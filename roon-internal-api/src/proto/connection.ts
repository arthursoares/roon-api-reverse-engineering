/**
 * RoonConnection — the transport beneath the remoting layer.
 *
 * Sequence (the ROON-magic handshake + DistributedBroker ConnectRequest live
 * below the remoting frame layer; verified working in examples/debug-flow.ts):
 *   1. TCP connect to host:9332
 *   2. ROON 0104 hello (server broker id + our random client broker id)
 *   3. <- ROON 0180 ack ; -> ROON 0102 ; <- ROON 0182 + session id
 *   4. -> ConnectRequest (a SENDMSG frame; we reuse the captured template)
 *   5. <- ConnectResponse ; thereafter all bytes are remoting frames
 *
 * After step 5, raw bytes are forwarded to whatever onData handler the
 * RemotingClient registered, and send() writes remoting frames to the socket.
 */
import * as net from 'net';
import * as crypto from 'crypto';
import { Transport } from './remoting';

const MAGIC = Buffer.from('ROON');

// ConnectRequest template (a SENDMSG frame), client broker id = XXXX...
// Captured from the official client; ProtocolVersion 28 / production branch.
const CONNECT_REQUEST_TEMPLATE =
  '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

export interface ConnectionOptions {
  host: string;
  port?: number;
  /** 16-byte server broker id (from SOOD discovery / project notes). */
  serverBrokerId: Buffer;
}

export class RoonConnection implements Transport {
  private socket: net.Socket | null = null;
  private dataHandler: (chunk: Buffer) => void = () => {};
  private established = false;
  readonly clientBrokerId = crypto.randomBytes(16);

  constructor(private opts: ConnectionOptions) {}

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandler = handler;
  }

  send(data: Buffer): void {
    if (!this.socket) throw new Error('not connected');
    this.socket.write(data);
  }

  /** Complete TCP + ROON handshake + ConnectRequest; resolves when remoting is live. */
  connect(): Promise<void> {
    const { host, port = 9332, serverBrokerId } = this.opts;
    return new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let step = 0;
      socket.setTimeout(20000);

      const fail = (e: Error) => {
        socket.destroy();
        reject(e);
      };

      socket.on('timeout', () => fail(new Error('connection timed out during handshake')));
      socket.on('error', fail);

      socket.on('connect', () => {
        step = 1;
        socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), serverBrokerId, this.clientBrokerId]));
      });

      socket.on('data', (data: Buffer) => {
        if (this.established) {
          this.dataHandler(data);
          return;
        }
        // Handshake state machine. Each step here is a discrete small packet.
        if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
          const code = data[5];
          if (step === 1 && code === 0x80) {
            step = 2;
            socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
            return;
          }
          if (step === 2 && code === 0x82) {
            step = 3;
            const cr = Buffer.from(
              CONNECT_REQUEST_TEMPLATE.replace(
                'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                this.clientBrokerId.toString('hex')
              ),
              'hex'
            );
            socket.write(cr);
            return;
          }
        }
        // First non-ROON bytes after ConnectRequest == ConnectResponse: remoting is live.
        if (step === 3) {
          this.established = true;
          resolve();
          // The ConnectResponse and any trailing bytes belong to the remoting layer.
          this.dataHandler(data);
        }
      });

      socket.connect(port, host);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
