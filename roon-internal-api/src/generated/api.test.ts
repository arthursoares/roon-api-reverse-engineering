import { EndpointApi, LibraryApi, TransportApi, VirtualAlbumLiteQueryApi, VirtualHistoryPlayQueryApi, ZoneApi, makeApi } from './api';

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
  test('nullable method arguments retain null and non-null wire representations', async () => {
    const { c, calls } = stub();
    const endpoint = new EndpointApi(c, 46n);
    await endpoint.setVolumeLimits(null, null, null);
    expect(calls[0].args.toString('hex')).toBe('000000');

    const zone = new ZoneApi(c, 46n);
    await zone.setSleepTimer(null, 5);
    expect(calls[1].args.toString('hex')).toBe('020105');
    await zone.setSleepTimer(false, null);
    expect(calls[2].args.toString('hex')).toBe('0000');

    const library = new LibraryApi(c, 46n);
    const sooid = Buffer.from('3f0116', 'hex');
    await library.getLocalizedEntityText(sooid, 1n, null, Buffer.alloc(0));
    expect(calls[3].args.toString('hex')).toBe('033f0116018fffffff7f');
    await library.getLocalizedEntityText(null, 1n, null, Buffer.alloc(0));
    expect(calls[4].args.toString('hex')).toBe('8fffffff7f018fffffff7f');
  });

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

  test('ReleasePage is fire-and-forget: the Core never answers it', () => {
    // Awaiting it waited out the request timeout and rejected after a release
    // that had succeeded — inviting a retry, i.e. a double release.
    const { c, calls, noReply } = stub();
    const albums = new VirtualAlbumLiteQueryApi(c, 77n);
    expect(albums.releasePage(0)).toBeUndefined();
    new VirtualHistoryPlayQueryApi(c, 78n).releasePage(2);
    expect(calls).toHaveLength(0);
    expect(noReply.map((r) => r.sig)).toEqual([
      'Sooloos.Broker.Api.VirtualAlbumLiteQuery::ReleasePage(int, Base.ResultCallback)',
      'Sooloos.Broker.Api.VirtualHistoryPlayQuery::ReleasePage(int, Base.ResultCallback)',
    ]);
    expect(noReply[1].args.toString('hex')).toBe('02');
  });

  test('RetainPage still awaits its reply', async () => {
    const { c, calls, noReply } = stub();
    const r = await new VirtualAlbumLiteQueryApi(c, 77n).retainPage(0);
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(noReply).toHaveLength(0);
  });

  test('makeApi exposes service accessors', () => {
    const { c } = stub();
    const api = makeApi(c);
    expect(api.library).toBeInstanceOf(LibraryApi);
    expect(api.transport).toBeInstanceOf(TransportApi);
  });
});
