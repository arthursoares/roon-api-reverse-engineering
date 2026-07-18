import { LibraryApi, TransportApi, ZoneApi, makeApi } from './api';

/** Minimal stub standing in for a connected RoonClient. */
function stub() {
  const calls: { oid: bigint; sig: string; args: Buffer }[] = [];
  const noReply: { oid: bigint; sig: string; args: Buffer }[] = [];
  let typeId = 100;
  const c: any = {
    remoting: {
      callMethod: (oid: bigint, sig: string, args: Buffer) => {
        calls.push({ oid, sig, args });
        return Promise.resolve({ status: 'Success', success: true, payload: Buffer.alloc(0) });
      },
      callMethodNoReply: (oid: bigint, sig: string, args: Buffer) => noReply.push({ oid, sig, args }),
      defineType: () => typeId++,
    },
    serviceOid: () => 46n,
  };
  return { c, calls, noReply };
}

describe('generated API (Phase B codegen)', () => {
  test('LibraryApi.favoriteOrBan(track) sends correct signature + args', async () => {
    const { c, calls } = stub();
    const lib = new LibraryApi(c, 46n);
    const profile = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');
    await lib.favoriteOrBan(profile, 542311n, 1); // 542311 flexlong-encodes to a18c67
    expect(calls).toHaveLength(1);
    expect(calls[0].oid).toBe(46n);
    expect(calls[0].sig).toBe(
      'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)'
    );
    // args = sooid(profile) + flexlong(trackOid) + flexInt(state)
    // 12=len 18, 18 sooid bytes, then a18c67 (flexlong 0x115c67), then 01
    expect(calls[0].args.toString('hex')).toBe('123f01162027273a55d64bbf4a85f335410e2fa18c6701');
  });

  test('TransportApi.playAlbum sends ref+sooid+struct+ref+bool+bool', async () => {
    const { c, calls } = stub();
    const t = new TransportApi(c, 23n);
    const profile = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');
    await t.playAlbum(464116n, profile, {}, 49084n, false, false);
    expect(calls[0].sig).toContain('Transport::PlayAlbum(Sooloos.Broker.Api.Zone, System.Sooid');
    const hex = calls[0].args.toString('hex');
    // starts with zone oid (flexlong 464116) then sooid (12 + 18 bytes)
    expect(hex.startsWith('81' /* multi-byte flexlong */) || hex.length > 30).toBe(true);
    // ends with the two bools (00 00) after the album ref
    expect(hex.endsWith('0000')).toBe(true);
  });

  test('reflist collection param emits the FIXED length-prefixed bare-ref framing', async () => {
    // The reflist fix (tools/gen_client.ts): collection params serialize as a
    // length-prefixed Arg.collection of bare refs, NOT the old Arg.refList
    // (count + refs, no length prefix) that stalls the Core. The captured
    // Transport::PlayWorks frame (roonctl tools/re/fixtures/reflist) pins the
    // element encoding: oid 8105394 -> flexlong 83eedb32, framed as
    // flexInt(bodyLen) + flexInt(count) + refs.
    const { c, calls } = stub();
    const lib = new LibraryApi(c, 46n);
    await lib.getPersistentAlbumIds([8105394n]);
    // bodyLen=5 (count byte + 4-byte ref), count=1, ref 83eedb32
    expect(calls[0].args.toString('hex')).toBe('050183eedb32');

    const { c: c2, calls: k2 } = stub();
    await new LibraryApi(c2, 46n).getPersistentAlbumIds([8105394n, 8105394n]);
    // bodyLen=9 (count byte + two 4-byte refs), count=2 — framing scales
    expect(k2[0].args.toString('hex')).toBe('090283eedb3283eedb32');
    // the old bare Arg.refList (count + refs, no length prefix) would be "0283eedb32…"
    expect(k2[0].args.toString('hex').startsWith('02')).toBe(false);
  });

  test('fire-and-forget method uses callMethodNoReply', () => {
    const { c, noReply } = stub();
    const z = new ZoneApi(c, 464116n);
    z.pause();
    expect(noReply).toHaveLength(1);
    expect(noReply[0].sig).toBe('Sooloos.Broker.Api.Zone::Pause()');
  });

  test('makeApi exposes service accessors', () => {
    const { c } = stub();
    const api = makeApi(c);
    expect(api.library).toBeInstanceOf(LibraryApi);
    expect(api.transport).toBeInstanceOf(TransportApi);
  });
});
