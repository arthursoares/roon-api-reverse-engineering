/**
 * BinaryWriter — faithful port of the write half of
 * Sooloos.Broker.Remoting.RemotingUtils.
 *
 * Every method matches the C# wire output byte-for-byte. Validated against
 * captured official-client packets and (separately) the C# oracle.
 */
import { writeFlexInt, writeFlexLong } from './flex';

export class BinaryWriter {
  private out: number[] = [];

  get length(): number {
    return this.out.length;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.out);
  }

  /** Raw bytes, no framing. */
  bytes(b: Uint8Array | number[]): this {
    for (const x of b) this.out.push(x as number);
    return this;
  }

  byte(b: number): this {
    this.out.push(b & 0xff);
    return this;
  }

  // --- RemotingUtils primitives ---

  /** WriteInteger == WriteFlexInt (signed int; -1 encodes as uint32 0xFFFFFFFF). */
  integer(v: number): this {
    writeFlexInt(this.out, v);
    return this;
  }

  flexInt(v: number): this {
    writeFlexInt(this.out, v);
    return this;
  }

  long(v: bigint | number): this {
    writeFlexLong(this.out, v);
    return this;
  }

  boolean(v: boolean): this {
    this.out.push(v ? 1 : 0);
    return this;
  }

  /** WriteString: integer(utf8.length) + utf8 bytes; null -> integer(-1). */
  string(v: string | null): this {
    if (v === null || v === undefined) {
      this.integer(-1);
      return this;
    }
    const utf8 = Buffer.from(v, 'utf8');
    this.integer(utf8.length);
    return this.bytes(utf8);
  }

  /** WriteOptionalString: null -> integer(-1), else WriteString. */
  optionalString(v: string | null): this {
    return v === null || v === undefined ? this.integer(-1) : this.string(v);
  }

  /** WriteSooid: integer(bytes.length) + bytes. Sooid is a raw byte id. */
  sooid(bytes: Uint8Array): this {
    this.integer(bytes.length);
    return this.bytes(bytes);
  }

  optionalSooid(bytes: Uint8Array | null): this {
    if (bytes === null || bytes === undefined) {
      // WriteOptionalSooid writes a presence/empty marker; see C#: null -> integer(-1)
      return this.integer(-1);
    }
    return this.sooid(bytes);
  }

  /** WriteGuid: 16 raw bytes in .NET Guid.ToByteArray() order. */
  guid(guid16: Uint8Array): this {
    if (guid16.length !== 16) throw new Error('guid must be 16 bytes');
    return this.bytes(guid16);
  }

  /** WriteDouble: little-endian IEEE-754 (BitConverter.GetBytes). */
  double(v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    return this.bytes(b);
  }

  float(v: number): this {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    return this.bytes(b);
  }

  /** WriteByteArray: integer(len) + bytes; null -> integer(-1). */
  byteArray(v: Uint8Array | null): this {
    if (v === null || v === undefined) return this.integer(-1);
    this.integer(v.length);
    return this.bytes(v);
  }

  // --- Optionals that use a trailing marker (C#: value, or marker byte 2) ---

  optionalBoolean(v: boolean | null): this {
    if (v === null || v === undefined) this.out.push(2);
    else this.out.push(v ? 1 : 0);
    return this;
  }
}
