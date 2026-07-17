import { serializeStructValue, inlineStruct, Arg, buildArgs } from './serializer';
import { BinaryWriter } from './writer';
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

// Collection encoding for IEnumerable<T>-of-structs params (FavoriteOrBan et al).
// Wire format validated byte-for-byte against the official client's captured
// FavoriteOrBan call: flexInt(bodyLen) + flexInt(count) + serialized elements.
describe('IEnumerable collection encoding', () => {
  test('Arg.collection is length-prefixed: flexInt(bodyLen) + flexInt(count) + elements', () => {
    const out = buildArgs([Arg.collection([Buffer.from('aa', 'hex'), Buffer.from('bbbb', 'hex')])]);
    // body = flexInt(2) 'aa' 'bbbb' (4 bytes) -> flexInt(4) + body
    expect(out.toString('hex')).toBe('0402aabbbb');
  });

  test('an empty collection is a 1-byte body holding count 0', () => {
    expect(buildArgs([Arg.collection([])]).toString('hex')).toBe('0100');
  });

  test('FavoriteOrBan arg block decodes as sooid + AlbumLink collection + state', () => {
    // Mirrors favoriteAlbum: profile sooid, one AlbumLink{AlbumId, Broker}
    // element (member indexes 1 and 2), FavoriteBanState.Favorite.
    const albumId = 202799n; // stable id from the validation capture
    const brokerOid = 93n;
    const typeId = 9; // session-assigned DEFTYPE id — arbitrary here
    const profile = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');
    const link = inlineStruct(typeId, [
      { index: 1, value: new BinaryWriter().long(albumId).toBuffer() },
      { index: 2, value: new BinaryWriter().long(brokerOid).toBuffer() },
    ]);
    const args = buildArgs([Arg.sooid(profile), Arg.collection([link]), Arg.enum_(1)]);

    const r = new BinaryReader(Uint8Array.from(args));
    expect(r.sooid().toString('hex')).toBe(profile.toString('hex'));
    const bodyLen = r.flexInt();
    expect(bodyLen).toBe(link.length + 1); // count byte + one element
    expect(r.flexInt()).toBe(1); // count
    expect(r.long()).toBe(1n); // inline value-object marker
    expect(r.flexInt()).toBe(typeId);
    r.flexInt(); // sparse-body length
    expect(r.flexInt()).toBe(1); // member 1: AlbumId
    expect(r.long()).toBe(albumId);
    expect(r.flexInt()).toBe(2); // member 2: Broker ref
    expect(r.long()).toBe(brokerOid);
    expect(r.flexInt()).toBe(0); // struct terminator
    expect(r.flexInt()).toBe(1); // FavoriteBanState.Favorite
  });
});
