/**
 * Variable-length integer encoding, ported verbatim from
 * Sooloos.Broker.Remoting.RemotingUtils (Roon.Broker.Remoting.dll).
 *
 * Big-endian base-128: 7 bits per byte, most-significant group first,
 * continuation bit 0x80 set on every byte except the last.
 *
 *   WriteFlexInt(143)  => 81 0f   ((1<<7)|15)
 *   ReadFlexInt:  num = (num<<7) | (b & 0x7f), repeat while (b & 0x80)
 *
 * FlexInt is 32-bit (used for lengths, method ids, enum values). Negative
 * values (e.g. the -1 "null" length sentinel) are encoded as their uint32
 * bit pattern, matching C#'s `(uint)i` cast + `>>>` unsigned shifts.
 *
 * FlexLong is 64-bit (object ids). We use BigInt to stay exact past 2^53.
 */

/** Append a 32-bit flex int to a growing byte array. */
export function writeFlexInt(out: number[], value: number): void {
  // Match C# unsigned semantics: operate on the uint32 bit pattern.
  const u = value >>> 0;
  if (u <= 0x7f) {
    out.push(u);
  } else if (u <= 0x3fff) {
    out.push(0x80 | (u >>> 7), u & 0x7f);
  } else if (u <= 0x1fffff) {
    out.push(0x80 | (u >>> 14), 0x80 | (u >>> 7), u & 0x7f);
  } else if (u <= 0xfffffff) {
    out.push(0x80 | (u >>> 21), 0x80 | (u >>> 14), 0x80 | (u >>> 7), u & 0x7f);
  } else {
    out.push(
      0x80 | (u >>> 28),
      0x80 | ((u >>> 21) & 0x7f),
      0x80 | ((u >>> 14) & 0x7f),
      0x80 | ((u >>> 7) & 0x7f),
      u & 0x7f
    );
  }
}

/** Read a 32-bit flex int. Returns the value and the new position. */
export function readFlexInt(buf: Uint8Array, pos: number): [number, number] {
  let num = 0;
  for (;;) {
    const b = buf[pos++];
    num = (num << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [num >>> 0, pos];
}

/** Append a 64-bit flex long (object ids etc.). */
export function writeFlexLong(out: number[], value: bigint | number): void {
  let u = BigInt(value) & 0xffffffffffffffffn; // wrap to 64-bit like (ulong)i
  // Determine number of 7-bit groups needed.
  const groups: number[] = [];
  // Emit least-significant 7 bits first, then reverse to big-endian order.
  if (u === 0n) {
    out.push(0);
    return;
  }
  while (u > 0n) {
    groups.push(Number(u & 0x7fn));
    u >>= 7n;
  }
  groups.reverse();
  for (let i = 0; i < groups.length; i++) {
    out.push(i === groups.length - 1 ? groups[i] : 0x80 | groups[i]);
  }
}

/** Read a 64-bit flex long. Returns [value, newPos]. */
export function readFlexLong(buf: Uint8Array, pos: number): [bigint, number] {
  let num = 0n;
  for (;;) {
    const b = buf[pos++];
    num = (num << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [num, pos];
}
