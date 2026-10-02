import { RoonClient, parseAlbumEditInfo } from './client';
import { RemotingClient, Cmd, Transport } from './remoting';
import { FrameParser, encodeResponse } from './frame';
import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';
import { RoonObject, PropertyType } from './objects';
import { LibraryApi, TransportApi } from '../generated/api';

class MockTransport implements Transport {
  sent: Buffer[] = [];
  private handler: (c: Buffer) => void = () => {};
  send(data: Buffer) {
    this.sent.push(data);
  }
  onData(h: (c: Buffer) => void) {
    this.handler = h;
  }
  deliver(data: Buffer) {
    this.handler(data);
  }
  sentFrames() {
    const p = new FrameParser();
    return p.push(Buffer.concat(this.sent));
  }
}

/** A RoonClient wired to a mock transport instead of a live socket. */
function buildClient(profileSooid?: Buffer) {
  const t = new MockTransport();
  const c = new RoonClient({ host: 'test', serverBrokerId: Buffer.alloc(16), profileSooid });
  // Swap the remoting layer for one on the mock transport (readonly is
  // compile-time only); keep pushes flowing into the same graph.
  (c as any).remoting = new RemotingClient(t);
  c.remoting.onPush = (f) => c.graph.ingest(f);
  (c as any).searchSettleMs = 30; // keep the test fast
  return { c, t };
}

function seed(c: RoonClient, oid: bigint, typeName: string, fields: Record<string, unknown> = {}) {
  c.graph.objects.set(oid.toString(), { oid, typeId: 0, typeName, fields } as RoonObject);
}

const PROFILE_ID = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');

function seedCore(c: RoonClient) {
  seed(c, 43n, 'Sooloos.Broker.Api.Library');
  seed(c, 124n, 'Sooloos.Broker.Api.Profile', {
    'Sooloos.Broker.Api.Profile::ProfileId': PROFILE_ID,
  });
}

interface DeclaredType {
  name: string;
  members: { name: string; propType: number }[];
}

function declaredTypes(t: MockTransport): Map<number, DeclaredType> {
  const types = new Map<number, DeclaredType>();
  for (const frame of t.sentFrames().filter((f) => f.cmd === Cmd.DEFTYPE)) {
    const r = new BinaryReader(frame.body);
    const id = r.flexInt();
    const name = r.string() ?? '';
    const members = Array.from({ length: r.flexInt() }, () => ({
      name: r.string() ?? '',
      propType: r.integer(),
    }));
    types.set(id, { name, members });
  }
  // Remote IDs resolve a local type whose property mapping is shared.
  const localMappings = new Map<string, DeclaredType>();
  for (const type of types.values()) localMappings.set(type.name, type);
  for (const [id, type] of types) types.set(id, localMappings.get(type.name)!);
  return types;
}

function inlineValue(r: BinaryReader): { typeId: number; body: BinaryReader } {
  expect(r.long()).toBe(1n);
  const typeId = r.flexInt();
  return { typeId, body: new BinaryReader(r.bytes(r.flexInt())) };
}

async function completeLatestCall(t: MockTransport, result: Promise<unknown>): Promise<void> {
  const call = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
  t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('').toBuffer(), true));
  await result;
}

function latestAlbumEdit(t: MockTransport): { memberName: string; value: BinaryReader } {
  const types = declaredTypes(t);
  const call = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
  const callBody = new BinaryReader(call.body);
  callBody.long(); // Library service oid
  callBody.flexInt(); // Edit method id

  const libraryEdit = inlineValue(callBody);
  const libraryBody = libraryEdit.body;
  expect(types.get(libraryEdit.typeId)!.members[libraryBody.flexInt() - 1].name).toContain('::Albums');
  const albumsBlob = new BinaryReader(libraryBody.bytes(libraryBody.integer()));
  expect(albumsBlob.flexInt()).toBe(1); // one AlbumEdit

  const albumEdit = inlineValue(albumsBlob);
  const albumType = types.get(albumEdit.typeId)!;
  const albumBody = albumEdit.body;
  expect(albumBody.flexInt()).toBe(1); // AlbumId
  albumBody.long();
  const memberIndex = albumBody.flexInt();
  return {
    memberName: albumType.members[memberIndex - 1].name,
    value: albumBody,
  };
}

describe('profile resolution', () => {
  test('profile() reads the ProfileId from the graph Profile object', () => {
    const { c } = buildClient();
    seedCore(c);
    expect(c.profile().toString('hex')).toBe(PROFILE_ID.toString('hex'));
  });

  test('an explicit profileSooid option wins over the graph', () => {
    const explicit = Buffer.from('3f01ff', 'hex');
    const { c } = buildClient(explicit);
    seedCore(c);
    expect(c.profile().toString('hex')).toBe('3f01ff');
  });

  test('profile() fails with a pointer to connect() when nothing is available', () => {
    const { c } = buildClient();
    expect(() => c.profile()).toThrow(/connect\(\)/);
  });
});

function searchRoot(c: RoonClient, rootId: bigint, ids: bigint[]) {
  seed(c, rootId, 'Sooloos.Broker.Api.UnifiedSearchResults', {
    'Sooloos.Broker.Api.UnifiedSearchResults::Performers': { $ref: rootId + 1n },
  });
  seed(c, rootId + 1n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.PerformerLite>', {
    $count: ids.length, $items: ids.map(($ref) => ({ $ref })),
  });
}

function respondSearch(t: MockTransport, rootId: bigint) {
  const call = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
  t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('Success').long(rootId).toBuffer(), true));
}

describe('UnifiedSearch', () => {
  test('declares SearchParameters members by their FULL wire names', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, []);
    const p = c.search('abbey road', 10);
    respondSearch(t, 100n);
    await p;
    const deftypes = t.sentFrames().filter((f) => f.cmd === Cmd.DEFTYPE)
      .map((f) => f.body.toString('utf8')).join('\n');
    expect(deftypes).toContain('System.Sooid Sooloos.Broker.Api.SearchParameters::ProfileId');
    expect(deftypes).toContain('string Sooloos.Broker.Api.SearchParameters::Terms');
    expect(deftypes).toContain('int Sooloos.Broker.Api.SearchParameters::MaxCount');
    expect(deftypes).toContain('int Sooloos.Broker.Api.SearchParameters::MaxTopResultCount');
  });

  test('repeated queries return existing identities in membership order, excluding unrelated pushes', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    seed(c, 901n, 'Sooloos.Broker.Api.PerformerLite');
    seed(c, 902n, 'Sooloos.Broker.Api.PerformerLite');
    searchRoot(c, 100n, [902n, 901n, 902n]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = c.search('query', 10);
      seed(c, BigInt(950 + attempt), 'Sooloos.Broker.Api.AlbumLite');
      respondSearch(t, 100n);
      expect((await p).map((o) => o.oid)).toEqual([902n, 901n]);
    }
  });

  test.each([
    ['Album', 'Albums'], ['Track', 'Tracks'], ['Performer', 'Performers'], ['Work', 'Works'],
  ])('accepts cached %s objects in Lite memberships without following metadata references', async (type, category) => {
    const { c, t } = buildClient();
    seedCore(c);
    seed(c, 901n, `Sooloos.Broker.Api.${type}`, { [`${type}::Related`]: { $ref: 999n } });
    seed(c, 902n, `Sooloos.Broker.Api.${type}Lite`);
    seed(c, 999n, `Sooloos.Broker.Api.${type}Lite`);
    const cached = c.graph.getObject(901n)!;
    seed(c, 100n, 'Sooloos.Broker.Api.UnifiedSearchResults', {
      [`UnifiedSearchResults::${category}`]: { $ref: 101n },
    });
    const refs = [{ $ref: 902n }, { $ref: 901n }, { $ref: 902n }, { $ref: 901n }];
    if (type === 'Album' || type === 'Track') {
      seed(c, 101n, `Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.${type}LiteVersions>`, {
        $count: 1, $items: [{ $ref: 102n }],
      });
      seed(c, 102n, `Sooloos.Broker.Api.${type}LiteVersions`, {
        [`${type}LiteVersions::${category}`]: { $ref: 103n },
      });
    }
    seed(c, type === 'Album' || type === 'Track' ? 103n : 101n,
      `Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.${type}Lite>`, {
        $count: refs.length, $items: refs,
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = c.search('query', 10);
      respondSearch(t, 100n);
      const hits = await pending;
      expect(hits.map((o) => o.oid)).toEqual([902n, 901n]);
      expect(hits[1]).toBe(cached);
      expect(hits[1].typeName).toBe(`Sooloos.Broker.Api.${type}`);
    }
  });

  test('different callback roots share cached entities without leaking previous membership', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    for (const oid of [901n, 902n, 903n]) seed(c, oid, 'Sooloos.Broker.Api.PerformerLite');
    searchRoot(c, 100n, [901n, 902n]);
    searchRoot(c, 200n, [903n, 901n]);
    const first = c.search('first', 10);
    respondSearch(t, 100n);
    expect((await first).map((o) => o.oid)).toEqual([901n, 902n]);
    const second = c.search('second', 10);
    respondSearch(t, 200n);
    expect((await second).map((o) => o.oid)).toEqual([903n, 901n]);
  });

  test('top results and version containers preserve ordering and stop at result entities', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    seed(c, 901n, 'Sooloos.Broker.Api.AlbumLite', { 'AlbumLite::Artist': { $ref: 999n } });
    seed(c, 902n, 'Sooloos.Broker.Api.AlbumLite');
    seed(c, 999n, 'Sooloos.Broker.Api.PerformerLite');
    seed(c, 100n, 'Sooloos.Broker.Api.UnifiedSearchResults', {
      'UnifiedSearchResults::TopSearchResults': { $ref: 101n },
      'UnifiedSearchResults::TopAlbum': { $ref: 102n },
    });
    seed(c, 101n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.TopSearchResult>', {
      $count: 1, $items: [{ $type: 'Sooloos.Broker.Api.TopSearchResult',
        'TopSearchResult::Album': { $ref: 902n } }],
    });
    seed(c, 102n, 'Sooloos.Broker.Api.AlbumLiteVersions', { 'AlbumLiteVersions::Albums': { $ref: 103n } });
    seed(c, 103n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.AlbumLite>', {
      $count: 2, $items: [{ $ref: 902n }, { $ref: 901n }],
    });
    const p = c.search('query', 10);
    respondSearch(t, 100n);
    expect((await p).map((o) => o.oid)).toEqual([902n, 901n]);
    const limited = c.search('query', 1);
    respondSearch(t, 100n);
    expect((await limited).map((o) => o.oid)).toEqual([902n]);
  });

  test('waits for only the returned membership graph when objects arrive after the callback', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    const p = c.search('query', 10);
    respondSearch(t, 100n);
    setTimeout(() => {
      searchRoot(c, 100n, [901n]);
      seed(c, 901n, 'Sooloos.Broker.Api.PerformerLite');
    }, 5);
    expect((await p).map((o) => o.oid)).toEqual([901n]);
  });

  test('incomplete memberships fail instead of silently returning empty or partial results', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, [901n]);
    const p = c.search('query', 10);
    respondSearch(t, 100n);
    await expect(p).rejects.toThrow(/incomplete/i);
  });

  test('a missing collection item waits for the full list update, not unrelated graph traffic', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, [901n, 902n]);
    seed(c, 901n, 'Sooloos.Broker.Api.PerformerLite');
    seed(c, 902n, 'Sooloos.Broker.Api.PerformerLite');
    c.graph.getObject(101n)!.fields.$items = [{ $ref: 901n }];
    const p = c.search('query', 10);
    respondSearch(t, 100n);
    setTimeout(() => {
      seed(c, 999n, 'Sooloos.Broker.Api.AlbumLite');
      c.graph.getObject(101n)!.fields.$items = [{ $ref: 902n }, { $ref: 901n }];
    }, 5);
    expect((await p).map((o) => o.oid)).toEqual([902n, 901n]);
  });

  test('overlapping queries use their own callback roots even when responses arrive out of order', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    seed(c, 901n, 'Sooloos.Broker.Api.PerformerLite');
    seed(c, 902n, 'Sooloos.Broker.Api.PerformerLite');
    searchRoot(c, 100n, [901n, 902n]);
    searchRoot(c, 200n, [902n]);
    const first = c.search('first', 10);
    const firstCall = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
    const second = c.search('second', 10);
    respondSearch(t, 200n);
    t.deliver(encodeResponse(firstCall.rid!, new BinaryWriter().string('Success').long(100n).toBuffer(), true));
    expect((await first).map((o) => o.oid)).toEqual([901n, 902n]);
    expect((await second).map((o) => o.oid)).toEqual([902n]);
  });

  test('a complete empty result stays empty despite unrelated pushes', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, []);
    const p = c.search('query', 10);
    seed(c, 901n, 'Sooloos.Broker.Api.AlbumLite');
    respondSearch(t, 100n);
    expect(await p).toEqual([]);
  });

  test.each([false, true])('playlist and genre membership is opt-in (%s)', async (includeNamed) => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, [901n]);
    seed(c, 901n, 'Sooloos.Broker.Api.PerformerLite');
    seed(c, 902n, 'Sooloos.Broker.Api.Playlist', { 'Playlist::Related': { $ref: 999n } });
    seed(c, 903n, 'Sooloos.Broker.Api.Playlist');
    seed(c, 904n, 'Sooloos.Broker.Api.BrowserGenre');
    seed(c, 905n, 'Sooloos.Broker.Api.GenreLite');
    seed(c, 999n, 'Sooloos.Broker.Api.Playlist');
    Object.assign(c.graph.getObject(100n)!.fields, {
      'UnifiedSearchResults::TopSearchResults': { $ref: 102n },
      'UnifiedSearchResults::Playlists': { $ref: 103n },
      'UnifiedSearchResults::Genres': { $ref: 104n },
    });
    seed(c, 102n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.TopSearchResult>', {
      $count: 2, $items: [
        { $type: 'Sooloos.Broker.Api.TopSearchResult', 'TopSearchResult::Playlist': { $ref: 902n } },
        { $type: 'Sooloos.Broker.Api.TopSearchResult', 'TopSearchResult::Genre': { $ref: 904n } },
      ],
    });
    seed(c, 103n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.Playlist>', {
      $count: 3, $items: [{ $ref: 903n }, { $ref: 902n }, { $ref: 903n }],
    });
    seed(c, 104n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.BrowserGenre>', {
      $count: 3, $items: [{ $ref: 905n }, { $ref: 904n }, { $ref: 905n }],
    });
    const expected = includeNamed ? [902n, 904n, 903n, 905n, 901n] : [901n];
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = c.search('query', 10, includeNamed);
      respondSearch(t, 100n);
      const hits = await pending;
      expect(hits.map((o) => o.oid)).toEqual(expected);
      for (const hit of hits) expect(hit).toBe(c.graph.getObject(hit.oid));
    }
    if (!includeNamed) {
      const pending = c.search('query', 10);
      respondSearch(t, 100n);
      expect((await pending).map((o) => o.oid)).toEqual([901n]);
    }
  });

  test('opt-in named lists precede broad categories within the global limit, after ranked hits', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, [901n, 902n, 903n, 904n, 905n]);
    for (const oid of [901n, 902n, 903n, 904n, 905n]) seed(c, oid, 'Sooloos.Broker.Api.PerformerLite');
    seed(c, 910n, 'Sooloos.Broker.Api.Playlist');
    seed(c, 911n, 'Sooloos.Broker.Api.BrowserGenre');
    Object.assign(c.graph.getObject(100n)!.fields, {
      'UnifiedSearchResults::Playlists': { $ref: 102n },
      'UnifiedSearchResults::Genres': { $ref: 103n },
    });
    seed(c, 102n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.Playlist>', {
      $count: 1, $items: [{ $ref: 910n }],
    });
    seed(c, 103n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.BrowserGenre>', {
      $count: 1, $items: [{ $ref: 911n }],
    });
    const defaultSearch = c.search('query', 3);
    respondSearch(t, 100n);
    expect((await defaultSearch).map((o) => o.oid)).toEqual([901n, 902n, 903n]);
    const optedIn = c.search('query', 3, true);
    respondSearch(t, 100n);
    expect((await optedIn).map((o) => o.oid)).toEqual([910n, 911n, 901n]);

    c.graph.getObject(100n)!.fields['UnifiedSearchResults::TopSearchResults'] = { $ref: 104n };
    seed(c, 104n, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.TopSearchResult>', {
      $count: 1, $items: [{ $type: 'Sooloos.Broker.Api.TopSearchResult',
        'TopSearchResult::Artist': { $ref: 905n } }],
    });
    const ranked = c.search('query', 3, true);
    respondSearch(t, 100n);
    expect((await ranked).map((o) => o.oid)).toEqual([905n, 910n, 911n]);
  });

  test('incomplete named membership is ignored by default and fails explicitly when opted in', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    searchRoot(c, 100n, []);
    c.graph.getObject(100n)!.fields['UnifiedSearchResults::Playlists'] = { $ref: 999n };
    const defaultSearch = c.search('query', 10);
    respondSearch(t, 100n);
    expect(await defaultSearch).toEqual([]);
    const optedIn = c.search('query', 10, true);
    respondSearch(t, 100n);
    await expect(optedIn).rejects.toThrow(/incomplete/i);
  });

  test('a failed call surfaces as an error instead of an empty result', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    const p = c.search('anything', 10);
    const call = t.sentFrames().find((f) => f.cmd === Cmd.CALL)!;
    t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('Exception').toBuffer(), true));
    await expect(p).rejects.toThrow(/UnifiedSearch failed/);
  });

  test('a success without a result reference is an invalid response', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    const p = c.search('anything', 10);
    const call = t.sentFrames().find((f) => f.cmd === Cmd.CALL)!;
    t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('Success').toBuffer(), true));
    await expect(p).rejects.toThrow(/result reference/i);
  });
});

describe('album edit struct schemas', () => {
  test('a labels edit after a genres edit retains the Labels member and values', async () => {
    const { c, t } = buildClient();
    seedCore(c);

    await completeLatestCall(t, c.editAlbum(17n, { addGenres: ['Jazz'] }));
    const labels = c.editAlbum(17n, { addLabels: ['ECM'] });
    const decoded = latestAlbumEdit(t);
    await completeLatestCall(t, labels);

    expect(decoded.memberName).toContain('::Labels');
    const editList = inlineValue(decoded.value);
    const editListType = declaredTypes(t).get(editList.typeId)!;
    expect(editListType.members[editList.body.flexInt() - 1].name).toContain('::AddValues');
    const added = new BinaryReader(editList.body.bytes(editList.body.integer()));
    expect(added.flexInt()).toBe(1);
    expect(added.string()).toBe('ECM');
  });

  test('a rating edit after a title edit retains the Rating member and value', async () => {
    const { c, t } = buildClient();
    seedCore(c);

    await completeLatestCall(t, c.editAlbum(17n, { title: 'Old title' }));
    const rating = c.editAlbum(17n, { rating: 5 });
    const decoded = latestAlbumEdit(t);
    await completeLatestCall(t, rating);

    expect(decoded.memberName).toContain('::Rating');
    const editRating = inlineValue(decoded.value);
    const ratingType = declaredTypes(t).get(editRating.typeId)!;
    expect(ratingType.members[editRating.body.flexInt() - 1].name).toContain('::EditValue');
    expect(editRating.body.boolean()).toBe(true);
    expect(editRating.body.integer()).toBe(5);
  });
});


describe('canonical struct schemas', () => {
  test('receiver retains Genres -> Labels -> Genres across repeated edits', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    for (const name of ['Genres', 'Labels', 'Genres']) {
      const pending = c.editAlbum(17n, name === 'Genres' ? { addGenres: ['Jazz'] } : { addLabels: ['ECM'] });
      const decoded = latestAlbumEdit(t);
      await completeLatestCall(t, pending);
      expect(decoded.memberName).toContain(`::${name}`);
    }
    expect([...declaredTypes(t).values()].filter((x) => x.name.endsWith('.AlbumEdit'))).toHaveLength(1);
  });

  test.each([true, false])('generated and handwritten SearchParameters share a schema (generated first: %s)', async (generatedFirst) => {
    const { c, t } = buildClient();
    seedCore(c);
    const api = new LibraryApi(c, 43n);
    const generated = async () => {
      const pending = api.unifiedSearch({ Terms: 'generated', MaxCount: 7 });
      const call = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
      const r = new BinaryReader(call.body);
      r.long(); r.flexInt();
      const value = inlineValue(r);
      const schema = declaredTypes(t).get(value.typeId)!;
      expect(schema.members[value.body.flexInt() - 1].name).toBe('string Sooloos.Broker.Api.SearchParameters::Terms');
      expect(value.body.string()).toBe('generated');
      expect(schema.members[value.body.flexInt() - 1].name).toBe('int Sooloos.Broker.Api.SearchParameters::MaxCount');
      expect(value.body.integer()).toBe(7);
      expect(value.body.flexInt()).toBe(0);
      await completeLatestCall(t, pending);
    };
    const handwritten = async () => {
      searchRoot(c, 100n, []);
      const pending = c.search('handwritten', 5);
      respondSearch(t, 100n);
      await pending;
    };
    await (generatedFirst ? generated() : handwritten());
    await (generatedFirst ? handwritten() : generated());
    const schemas = [...declaredTypes(t).values()];
    expect(schemas).toHaveLength(1);
    expect(schemas[0].members).toHaveLength(8);
    expect(schemas[0].members[1].name).toBe('string Sooloos.Broker.Api.SearchParameters::Terms');
  });

  test('empty and reordered fields use the same schema and stable indexes', () => {
    const { c, t } = buildClient();
    const type = 'Sooloos.Broker.Api.SearchParameters';
    const empty = inlineValue(new BinaryReader(c.structArg(type, [])));
    expect(empty.body.flexInt()).toBe(0);
    const populated = inlineValue(new BinaryReader(c.structArg(type, [
      { name: 'MaxCount', propType: PropertyType.Int, value: new BinaryWriter().integer(9).toBuffer() },
      { name: `string ${type}::Terms`, propType: PropertyType.String, value: new BinaryWriter().string('query').toBuffer() },
    ])));
    expect(populated.typeId).toBe(empty.typeId);
    expect(populated.body.flexInt()).toBe(3);
    expect(populated.body.integer()).toBe(9);
    expect(populated.body.flexInt()).toBe(2);
    expect(populated.body.string()).toBe('query');
    expect(declaredTypes(t).size).toBe(1);
  });
});


test('default handwritten PlayParameters can precede a populated generated call', async () => {
  const { c, t } = buildClient();
  seedCore(c);
  seed(c, 80n, 'Sooloos.Broker.Api.Transport');
  await completeLatestCall(t, c.playAlbum(90n, 91n));
  await completeLatestCall(t, new TransportApi(c, 80n).playAlbum(90n, PROFILE_ID, { Shuffle: true }, 91n, false, false));
  const types = [...declaredTypes(t).values()].filter((x) => x.name.endsWith('.PlayParameters'));
  expect(types).toHaveLength(1);
  expect(types[0].members).toHaveLength(5);
});

test('known structs reject unknown, duplicate and wrong-typed fields before sending', () => {
  const { c, t } = buildClient();
  const field = { name: 'Terms', propType: PropertyType.String, value: new BinaryWriter().string('term').toBuffer() };
  const type = 'Sooloos.Broker.Api.SearchParameters';
  expect(() => c.structArg(type, [{ ...field, name: 'Typo' }])).toThrow(/unknown member/);
  expect(() => c.structArg(type, [field, { ...field, name: `string ${type}::Terms` }])).toThrow(/duplicate member/);
  expect(() => c.structArg(type, [{ ...field, propType: PropertyType.Int }])).toThrow(/property type mismatch/);
  expect(t.sent).toHaveLength(0);
});

test('unknown types allow an immutable explicit schema and fail incompatible reuse', () => {
  const { c, t } = buildClient();
  const field = { name: 'int Vendor.Unknown::Count', propType: PropertyType.Int, value: new BinaryWriter().integer(3).toBuffer() };
  const first = c.structArg('Vendor.Unknown', [field]);
  expect(c.structArg('Vendor.Unknown', [field])).toEqual(first);
  expect(() => c.structArg('Vendor.Unknown', [])).toThrow(/incompatible schema/);
  expect(declaredTypes(t).size).toBe(1);
});

describe('album queries', () => {
  test('queryAlbums selects all, resolves albums by AlbumId, then disposes the query', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    const LINK = 'Sooloos.Broker.Api.AlbumLink';
    c.graph.types.set(900, { id: 900, name: LINK, members: [{ name: `long ${LINK}::AlbumId`, propType: PropertyType.Long }] });
    seed(c, 500n, 'Sooloos.Broker.Api.VirtualAlbumLiteQuery', { 'int Sooloos.Broker.Api.VirtualAlbumLiteQuery::Count': 2 });
    seed(c, 601n, 'Sooloos.Broker.Api.Album', { 'string Sooloos.Broker.Api.Album::Title': 'A' });

    const calls = () => t.sentFrames().filter((f) => f.cmd === Cmd.CALL);
    const reply = async (n: number, payload: Buffer = Buffer.alloc(0)) => {
      while (calls().length < n) await new Promise((r) => setImmediate(r));
      t.deliver(encodeResponse(calls()[n - 1].rid!, Buffer.concat([new BinaryWriter().string('').toBuffer(), payload]), true));
    };
    const link = (id: number) => {
      const f = new BinaryWriter().flexInt(1).long(id).flexInt(0).toBuffer();
      return new BinaryWriter().long(1).integer(900).integer(f.length).bytes(f).toBuffer();
    };
    const body = Buffer.concat([new BinaryWriter().flexInt(2).toBuffer(), link(1774792), link(920111)]);

    const pending = c.queryAlbums([], { resolveLimit: 1 });
    await reply(1, new BinaryWriter().long(500).toBuffer()); // VirtualAlbumQuery -> query object
    await reply(2); // SelectAll
    await reply(3, Buffer.concat([new BinaryWriter().flexInt(body.length).toBuffer(), body])); // GetSelected
    await reply(4, new BinaryWriter().long(601).toBuffer()); // GetAlbum(1774792)
    const r = await pending;

    expect(r.count).toBe(2);
    expect(r.ids).toEqual([1774792n, 920111n]);
    expect(r.albums.map((a) => a.oid)).toEqual([601n]);
    expect(calls()).toHaveLength(5); // four answered calls + the final no-reply Dispose (no rid)
    expect(calls()[4].rid).toBeNull();
    const methods = t.sentFrames().filter((f) => f.cmd !== Cmd.CALL && f.cmd !== Cmd.DEFTYPE).map((f) => f.body.toString('latin1'));
    expect(methods.some((m) => m.includes('VirtualAlbumLiteQuery::Dispose()'))).toBe(true);
  });
});

describe('album edit info', () => {
  const T = 'Sooloos.Broker.Api.EditRequiredRefInfo<string>';
  const L = 'Sooloos.Broker.Api.EditListInfo<string>';
  const stringList = (...xs: string[]) => {
    const w = new BinaryWriter().flexInt(xs.length);
    for (const x of xs) w.string(x);
    return w.toBuffer();
  };

  test('edited follows EditValue/AddValues, not HasEditLayer', () => {
    const untouched = parseAlbumEditInfo({
      [`${T} X::Title`]: { [`string ${T}::Value`]: 'Original Title', [`bool ${T}::HasEditLayer`]: true },
      [`${L} X::Genres`]: { [`${L}::Values`]: stringList('Pop'), [`bool ${L}::HasEditLayer`]: true },
    });
    expect(untouched.title).toMatchObject({ value: 'Original Title', edited: false, hasEditLayer: true });
    expect(untouched.genres).toMatchObject({ edited: false, hasEditLayer: true });

    const edited = parseAlbumEditInfo({
      [`${T} X::Title`]: { [`string ${T}::Value`]: 'B', [`string ${T}::EditValue`]: 'B', [`bool ${T}::HasEditLayer`]: true },
      [`${L} X::Genres`]: { [`${L}::AddValues`]: stringList('Jazz') },
    });
    expect(edited.title).toMatchObject({ value: 'B', editValue: 'B', edited: true });
    expect(edited.genres.edited).toBe(true);
  });

  test('clearTitle sends Title.ClearEdits instead of an EditValue', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    const pending = c.editAlbum(17n, { clearTitle: true });
    const decoded = latestAlbumEdit(t);
    await completeLatestCall(t, pending);
    expect(decoded.memberName).toContain('::Title');
    const w = inlineValue(decoded.value);
    expect(declaredTypes(t).get(w.typeId)!.members[w.body.flexInt() - 1].name).toContain('::ClearEdits');
    expect(w.body.boolean()).toBe(true);
    expect(() => c.editAlbum(17n, { title: 'x', clearTitle: true })).toThrow();
  });
});
