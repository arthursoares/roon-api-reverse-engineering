/**
 * Method-argument serializer.
 *
 * A call's argument block is each non-callback parameter serialized in order by
 * its type. We expose a small typed-arg API (the common cases needed to drive
 * methods) plus `buildArgs`. The mapping mirrors the remoting layer:
 *   - Sooid           -> integer(len) + bytes        (Arg.sooid)
 *   - by-ref object   -> flexLong(objectId)          (Arg.ref)   [0 = null]
 *   - enum            -> flexInt(value)               (Arg.enum_)
 *   - string/bool/... -> primitive                   (Arg.str/bool/int/long/double)
 *   - byte[]          -> integer(len) + bytes         (Arg.bytes)
 *   - IEnumerable<ref>-> integer(count) + refs        (Arg.refList)
 *   - ResultCallback  -> omitted (response travels via the request id)
 */
import { BinaryWriter } from './writer';

export type Arg =
  | { kind: 'sooid'; value: Uint8Array }
  | { kind: 'ref'; oid: bigint | number }
  | { kind: 'refList'; oids: (bigint | number)[] }
  | { kind: 'enum'; value: number }
  | { kind: 'str'; value: string | null }
  | { kind: 'bool'; value: boolean }
  | { kind: 'int'; value: number }
  | { kind: 'long'; value: bigint | number }
  | { kind: 'double'; value: number }
  | { kind: 'bytes'; value: Uint8Array | null };

export const Arg = {
  sooid: (value: Uint8Array): Arg => ({ kind: 'sooid', value }),
  ref: (oid: bigint | number): Arg => ({ kind: 'ref', oid }),
  refList: (oids: (bigint | number)[]): Arg => ({ kind: 'refList', oids }),
  enum_: (value: number): Arg => ({ kind: 'enum', value }),
  str: (value: string | null): Arg => ({ kind: 'str', value }),
  bool: (value: boolean): Arg => ({ kind: 'bool', value }),
  int: (value: number): Arg => ({ kind: 'int', value }),
  long: (value: bigint | number): Arg => ({ kind: 'long', value }),
  double: (value: number): Arg => ({ kind: 'double', value }),
  bytes: (value: Uint8Array | null): Arg => ({ kind: 'bytes', value }),
};

export function buildArgs(args: Arg[]): Buffer {
  const w = new BinaryWriter();
  for (const a of args) writeArg(w, a);
  return w.toBuffer();
}

/**
 * Serialize a single struct-member value by its PropertyType (objects.ts enum).
 * Covers the common settable cases; falls back to raw bytes for an already-
 * serialized Buffer. Used by generated code to populate struct args.
 */
export function serializeStructValue(propType: number, v: unknown): Buffer {
  const w = new BinaryWriter();
  if (Buffer.isBuffer(v) && propType !== 4 /*Sooid*/ && propType !== 21 /*ByteArray*/) {
    return v; // caller pre-serialized
  }
  switch (propType) {
    case 0: return w.integer(Number(v)).toBuffer(); // Int
    case 1: return w.long(v as any).toBuffer(); // Long
    case 2: return w.boolean(Boolean(v)).toBuffer(); // Bool
    case 3: return w.guid(v as Uint8Array).toBuffer(); // Guid
    case 4: return w.sooid(v as Uint8Array).toBuffer(); // Sooid
    case 5: return w.double(Number(v)).toBuffer(); // Double
    case 6: return w.float(Number(v)).toBuffer(); // Float
    case 7: return w.integer(Number(v)).toBuffer(); // Char
    case 8: return w.long(v as any).toBuffer(); // DateTime (raw int64)
    case 9: return w.flexInt(Number(v)).toBuffer(); // Enum
    case 20: return w.string(v == null ? null : String(v)).toBuffer(); // String
    case 21: return w.byteArray(v as Uint8Array).toBuffer(); // ByteArray
    case 22: return w.byteArray(v as Uint8Array).toBuffer(); // Message
    case 23: return w.long(v as any).toBuffer(); // Object -> object id (flexlong)
    default:
      // Nullable* (10..19) bool-prefixed; unknown -> best effort.
      if (propType >= 10 && propType <= 19) {
        if (v == null) return w.boolean(false).toBuffer();
        return w.boolean(true).bytes(serializeStructValue(propType - 10, v)).toBuffer();
      }
      return Buffer.isBuffer(v) ? v : w.toBuffer();
  }
}

/**
 * Encode a by-value struct argument as an inline value object:
 *   flexLong(1) + flexInt(typeId) + flexInt(len) + <sparse fields>
 * where fields = (flexInt(memberIndex) + valueBytes)* then flexInt(0).
 * Pass the type id obtained from RemotingClient.defineType(...).
 * `fields` is empty for a default struct.
 */
export function inlineStruct(
  typeId: number,
  fields: { index: number; value: Buffer }[] = []
): Buffer {
  const fw = new BinaryWriter();
  for (const f of fields) fw.flexInt(f.index).bytes(f.value);
  fw.flexInt(0); // terminator
  const body = fw.toBuffer();
  return new BinaryWriter().long(1).flexInt(typeId).flexInt(body.length).bytes(body).toBuffer();
}

function writeArg(w: BinaryWriter, a: Arg): void {
  switch (a.kind) {
    case 'sooid':
      w.sooid(a.value);
      break;
    case 'ref':
      w.long(a.oid); // by-ref object => its object id (flexlong); 0 = null
      break;
    case 'refList':
      w.integer(a.oids.length);
      for (const oid of a.oids) w.long(oid);
      break;
    case 'enum':
      w.flexInt(a.value);
      break;
    case 'str':
      w.string(a.value);
      break;
    case 'bool':
      w.boolean(a.value);
      break;
    case 'int':
      w.integer(a.value);
      break;
    case 'long':
      w.long(a.value);
      break;
    case 'double':
      w.double(a.value);
      break;
    case 'bytes':
      w.byteArray(a.value);
      break;
  }
}
