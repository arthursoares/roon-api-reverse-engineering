/**
 * FSE binary message encoder — ported from FSE.BinaryWriter (Messaging.dll).
 *
 * This is the SECOND serialization format Roon uses: query criteria
 * (MusicQuery.AlbumCriteria etc.) are IMessage objects encoded as self-describing
 * `(length, typeMarker, name|mruIndex, value)` elements, NOT the remoting struct
 * format. Validated against from-start.pcap: WriteString("UiLanguage","en") =>
 * `16 81 0a 55694c616e6775616765 00000002 656e`.
 *
 * Element header `_WriteElementHeader(name, datatype, datalen)`:
 *   - name NEW (first use): writeLength(name.len + 1 + datalen + 1 + 4),
 *       byte(datatype), byte(name.len), utf8(name)
 *   - name CACHED (move-to-front MRU, max 128): writeLength(1 + datalen + 1 + 4),
 *       byte(datatype), byte(mruIndex | 0x80)
 * Type markers: BeginList=1, EndList=3, String=129, Int32=130, Int64/UInt64=131,
 *   Guid=132, Double=133, BoolTrue=134, BoolFalse=135, ByteStream=136, Sooid=137.
 * Lengths via writeLength (2-bit-prefixed BE); string/bytestream value length via
 * a 4-byte big-endian int.
 */

class Mru {
  private values: string[] = [];
  /** Returns [isNew, index]. Move-to-front; cap 128. */
  add(name: string): [boolean, number] {
    const i = this.values.indexOf(name);
    if (i >= 0) {
      this.values.splice(i, 1);
      this.values.unshift(name);
      return [false, i];
    }
    this.values.unshift(name);
    if (this.values.length > 128) this.values.pop();
    return [true, 0];
  }
}

export class FseWriter {
  private out: number[] = [];
  private mru = new Mru();

  toBuffer(): Buffer {
    return Buffer.from(this.out);
  }

  private writeLength(v: number): void {
    v = v >>> 0;
    if (v <= 127) this.out.push(v);
    else if (v <= 16383) this.out.push(0x80 | (v >> 8), v & 0xff);
    else if (v <= 2097151) this.out.push(0xc0 | (v >> 16), (v >> 8) & 0xff, v & 0xff);
    else this.out.push(0xe0 | (v >> 24), (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }

  private be32(v: number): void {
    this.out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }

  private header(name: string, datatype: number, datalen: number): void {
    const [isNew, index] = this.mru.add(name);
    if (!isNew) {
      const v = datalen >= 0 ? 1 + datalen + 1 + 4 : 0;
      this.writeLength(v);
      this.out.push(datatype & 0xff, (index | 0x80) & 0xff);
    } else {
      const v = datalen >= 0 ? name.length + 1 + datalen + 1 + 4 : 0;
      this.writeLength(v);
      this.out.push(datatype & 0xff, name.length & 0xff);
      for (const b of Buffer.from(name, 'utf8')) this.out.push(b);
    }
  }

  beginElementList(name: string): this {
    this.header(name, 1, -1);
    return this;
  }
  endElementList(): this {
    this.writeLength(5);
    this.out.push(3);
    return this;
  }

  string(name: string, v: string): this {
    const b = Buffer.from(v, 'utf8');
    this.header(name, 129, b.length + 4);
    this.be32(b.length);
    for (const x of b) this.out.push(x);
    return this;
  }
  int32(name: string, v: number): this {
    this.header(name, 130, 4);
    this.be32(v | 0);
    return this;
  }
  int64(name: string, v: bigint): this {
    this.header(name, 131, 8);
    let x = BigInt.asUintN(64, v);
    const bytes: number[] = [];
    for (let i = 0; i < 8; i++) { bytes.unshift(Number(x & 0xffn)); x >>= 8n; }
    for (const b of bytes) this.out.push(b);
    return this;
  }
  boolean(name: string, v: boolean): this {
    this.header(name, v ? 134 : 135, 4);
    this.be32(v ? 1 : 0);
    return this;
  }
  sooid(name: string, v: Uint8Array): this {
    this.header(name, 137, v.length + 4);
    this.be32(v.length);
    for (const b of v) this.out.push(b);
    return this;
  }
  guid(name: string, v: Uint8Array): this {
    this.header(name, 132, 16);
    for (let i = 0; i < 16; i++) this.out.push(v[i] ?? 0);
    return this;
  }
  double(name: string, v: number): this {
    this.header(name, 133, 8);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0); // FSE.BinaryWriter writes the raw 8 bytes; LE per BitConverter
    for (const x of b) this.out.push(x);
    return this;
  }
  byteStream(name: string, v: Uint8Array): this {
    this.header(name, 136, v.length + 4);
    this.be32(v.length);
    for (const b of v) this.out.push(b);
    return this;
  }
}

/**
 * Encode an IMessage: beginElementList(typeName) + write fields + endElementList.
 * (Matches FSEMessageEncoder.EncodeMessage + the trailing WriteEndElementList.)
 */
export function encodeMessage(typeName: string, writeFields: (w: FseWriter) => void): Buffer {
  const w = new FseWriter();
  w.beginElementList(typeName);
  writeFields(w);
  w.endElementList(); // close the message element list
  w.endElementList(); // EncodeBinaryMessage appends a trailing WriteEndElementList
  return w.toBuffer();
}
