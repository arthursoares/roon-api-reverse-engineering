import { serializeStructValue, inlineStruct } from './serializer';
import { BinaryReader } from './reader';

// Phase C: validate struct value encoding round-trips and matches captured bytes.
describe('struct value encoding (Phase C)', () => {
  test('round-trips common PropertyTypes', () => {
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(0, 42))).integer()).toBe(42); // Int
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(1, 123456789012n))).long()).toBe(123456789012n); // Long
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(2, true))).boolean()).toBe(true); // Bool
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(9, 3))).flexInt()).toBe(3); // Enum
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(20, 'joão'))).string()).toBe('joão'); // String
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(5, 1.5))).double()).toBe(1.5); // Double
    const sooid = Buffer.from('3f0116', 'hex');
    expect(new BinaryReader(Uint8Array.from(serializeStructValue(4, sooid))).sooid().toString('hex')).toBe('3f0116'); // Sooid
  });

  test('SearchParameters {ProfileId, Terms} matches captured official-client field bytes', () => {
    // From captures/search.pcap: ProfileId(idx1 sooid) + Terms(idx2 string "joão gilberto").
    const profile = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');
    const fields = [
      { index: 1, value: serializeStructValue(4, profile) }, // ProfileId : Sooid
      { index: 2, value: serializeStructValue(20, 'joão gilberto') }, // Terms : String
    ];
    const inline = inlineStruct(7, fields); // flexLong(1)+flexInt(typeId=7)+flexInt(len)+body
    const body = inline.subarray(3).toString('hex'); // strip 3-byte header (01 07 <len>)
    expect(body).toBe('01123f01162027273a55d64bbf4a85f335410e2f020e6a6fc3a36f2067696c626572746f00');
  });
});
