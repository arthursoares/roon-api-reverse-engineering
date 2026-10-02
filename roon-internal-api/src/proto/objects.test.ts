import { ObjectGraph, PropertyType, isRef } from './objects';
import { encodeRequest, FrameParser } from './frame';
import { BinaryWriter } from './writer';
import { writeFlexInt } from './flex';
const searchCollections: { frames: { cmd: number; typeId: number; type: string; oid: number;
  members: { name: string; propType: PropertyType }[]; bodyHex: string; refs: number[] }[] } =
  require('./fixtures/search-collections.json');

/** Feed raw frame bytes into a graph. */
function feed(g: ObjectGraph, ...packets: Buffer[]) {
  for (const p of packets) for (const f of new FrameParser().push(p)) g.ingest(f);
}

/** Build a DEFTYPE (cmd 7) body: typeId, name, count, [memberName, propType]. */
function defType(typeId: number, name: string, members: [string, PropertyType][]): Buffer {
  const w = new BinaryWriter().flexInt(typeId).string(name).flexInt(members.length);
  for (const [mn, pt] of members) {
    w.string(mn);
    const tmp: number[] = [];
    writeFlexInt(tmp, pt);
    w.bytes(tmp);
  }
  return encodeRequest(7, w.toBuffer(), null);
}

/**
 * Build a PUSHOBJ (cmd 3) body: oid, typeId, then sparse (memberIndex, value)
 * pairs terminated by index 0. `fieldsByIndex` maps 1-based member index ->
 * pre-serialized value bytes.
 */
function pushObj(oid: number, typeId: number, fieldsByIndex: [number, Buffer][]): Buffer {
  const w = new BinaryWriter().long(oid).flexInt(typeId);
  for (const [idx, val] of fieldsByIndex) w.flexInt(idx).bytes(val);
  w.flexInt(0); // terminator
  return encodeRequest(3, w.toBuffer(), null);
}

describe('ObjectGraph generic deserializer', () => {
  test('decodes a type + object with mixed field types, incl. object refs', () => {
    const g = new ObjectGraph();

    feed(
      g,
      defType(10, 'Sooloos.Broker.Api.TrackLite', [
        ['Sooloos.Broker.Api.TrackLite::RoonId', PropertyType.NullableLong],
        ['Sooloos.Broker.Api.TrackLite::Title', PropertyType.String],
        ['Sooloos.Broker.Api.TrackLite::Album', PropertyType.Object],
        ['Sooloos.Broker.Api.TrackLite::IsFavorite', PropertyType.Bool],
      ])
    );

    // object oid 99, type 10, sparse fields by 1-based member index:
    feed(
      g,
      pushObj(99, 10, [
        [1, new BinaryWriter().boolean(true).long(12345).toBuffer()], // RoonId (NullableLong)
        [2, new BinaryWriter().string('Hello').toBuffer()], // Title
        [3, new BinaryWriter().long(7).toBuffer()], // Album => ref oid 7
        [4, new BinaryWriter().boolean(true).toBuffer()], // IsFavorite
      ])
    );

    const obj = g.getObject(99n);
    expect(obj).toBeDefined();
    expect(obj!.typeName).toBe('Sooloos.Broker.Api.TrackLite');
    const f = obj!.fields;
    expect(f['Sooloos.Broker.Api.TrackLite::RoonId']).toBe(12345n);
    expect(f['Sooloos.Broker.Api.TrackLite::Title']).toBe('Hello');
    const albumRef = f['Sooloos.Broker.Api.TrackLite::Album'];
    expect(isRef(albumRef)).toBe(true);
    expect((albumRef as any).$ref).toBe(7n);
    expect(f['Sooloos.Broker.Api.TrackLite::IsFavorite']).toBe(true);
  });

  test('findByType locates a service object by short name', () => {
    const g = new ObjectGraph();
    feed(g, defType(1, 'Sooloos.Broker.Api.Library', []), pushObj(46, 1, []));
    const libs = g.findByType('Library');
    expect(libs.length).toBe(1);
    expect(libs[0].oid).toBe(46n);
  });

  test('null object ref decodes to null', () => {
    const g = new ObjectGraph();
    feed(
      g,
      defType(20, 'T', [['x', PropertyType.Object]]),
      pushObj(1, 20, [[1, new BinaryWriter().long(0).toBuffer()]])
    );
    expect(g.getObject(1n)!.fields['x']).toBeNull();
  });

  test('decodeReturnValue decodes a nested by-value struct (Get*EditInfo pattern)', () => {
    const g = new ObjectGraph();
    feed(
      g,
      defType(30, 'Wrapper', [['Wrapper::Value', PropertyType.String], ['Wrapper::HasEditLayer', PropertyType.Bool]]),
      defType(31, 'Info', [['Info::Title', PropertyType.Object]])
    );
    // inline Wrapper value: marker(1) + tid + len + sparse body (idx,value)* 0
    const wrapperBody = new BinaryWriter()
      .flexInt(1).bytes(new BinaryWriter().string('Hello').toBuffer())
      .flexInt(2).bytes(new BinaryWriter().boolean(true).toBuffer())
      .flexInt(0).toBuffer();
    const inlineWrapper = new BinaryWriter().long(1).flexInt(30).flexInt(wrapperBody.length).bytes(wrapperBody).toBuffer();
    // inline Info value whose Title member is the inline Wrapper
    const infoBody = new BinaryWriter().flexInt(1).bytes(inlineWrapper).flexInt(0).toBuffer();
    const inlineInfo = new BinaryWriter().long(1).flexInt(31).flexInt(infoBody.length).bytes(infoBody).toBuffer();

    const decoded = g.decodeReturnValue(Uint8Array.from(inlineInfo)) as Record<string, unknown>;
    expect(decoded.$type).toBe('Info');
    const title = decoded['Info::Title'] as Record<string, unknown>;
    expect(title.$type).toBe('Wrapper');
    expect(title['Wrapper::Value']).toBe('Hello');
    expect(title['Wrapper::HasEditLayer']).toBe(true);
  });
});

describe('DataList collection wire encoding', () => {
  test('decodes normalized live search frames, including overlapping ordered result lists', () => {
    const g = new ObjectGraph();
    for (const frame of searchCollections.frames) {
      feed(g, defType(frame.typeId, frame.type, frame.members.map((m) => [m.name, m.propType])));
      feed(g, encodeRequest(frame.cmd, Buffer.from(frame.bodyHex, 'hex'), null));
      const object = g.getObject(frame.oid)!;
      const refs = frame.refs.map((id) => ({ $ref: BigInt(id) }));
      if (frame.type.includes('DataList<')) {
        expect(object.fields).toEqual({ $count: refs.length, $items: refs });
      } else {
        expect(object.fields[frame.members[0].name]).toEqual(refs[0]);
      }
    }
  });

  test('count is the first value, with no sparse header or terminator', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.AlbumLite>', []));
    // oid=99, type=20, count=2, refs=901,902. This is the installed
    // DataList<AlbumLite> adapter format, not Query's (1,count,0) header.
    feed(g, encodeRequest(3, Buffer.from('63140287058706', 'hex'), null));
    expect(g.getObject(99n)!.fields).toEqual({ $count: 2, $items: [{ $ref: 901n }, { $ref: 902n }] });
    feed(g, encodeRequest(5, Buffer.from('6314018706', 'hex'), null));
    expect(g.getObject(99n)!.fields).toEqual({ $count: 1, $items: [{ $ref: 902n }] });
    feed(g, encodeRequest(5, Buffer.from('631400', 'hex'), null));
    expect(g.getObject(99n)!.fields).toEqual({ $count: 0, $items: [] });
  });

  test('truncated item references remain incomplete instead of gaining phantom objects', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.AlbumLite>', []));
    feed(g, encodeRequest(3, Buffer.from('631402870587', 'hex'), null));
    expect(g.getObject(99n)!.fields).toEqual({ $count: 2, $items: [{ $ref: 901n }] });
  });

  test('DataList element encoding respects strings and primitive values', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.DataList<string>', []));
    feed(g, encodeRequest(3, Buffer.from('63140201410142', 'hex'), null));
    expect(g.getObject(99n)!.fields.$items).toEqual(['A', 'B']);
    feed(g, defType(21, 'Sooloos.Broker.Api.DataList<int>', []));
    feed(g, encodeRequest(3, Buffer.from('6415020102', 'hex'), null));
    expect(g.getObject(100n)!.fields.$items).toEqual([1, 2]);
  });

  test('DataList<TopSearchResult> reads inline values through the Object codec', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.TopSearchResult>', []));
    feed(g, defType(21, 'Sooloos.Broker.Api.TopSearchResult', [['TopSearchResult::Album', PropertyType.Object]]));
    // list oid=99/type=20/count=1; inline marker=1/type=21/length=4;
    // sparse album member=1/ref=901 followed by terminator=0.
    feed(g, encodeRequest(3, Buffer.from('63140101150401870500', 'hex'), null));
    expect(g.getObject(99n)!.fields).toEqual({ $count: 1, $items: [{
      $type: 'Sooloos.Broker.Api.TopSearchResult', 'TopSearchResult::Album': { $ref: 901n },
    }] });
  });

  test('a missing DataList count cannot masquerade as a complete empty list', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.AlbumLite>', []));
    feed(g, encodeRequest(3, Buffer.from('6314', 'hex'), null));
    expect(g.getObject(99n)!.fields.$count).toBe(-1);
  });

  test('a repeated PUSHSTUB retains populated collection identity and membership', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.AlbumLite>', []));
    feed(g, encodeRequest(3, Buffer.from('6314018705', 'hex'), null));
    const original = g.getObject(99n)!;
    feed(g, encodeRequest(4, Buffer.from('6314', 'hex'), null));
    expect(g.getObject(99n)).toBe(original);
    expect(original.fields).toEqual({ $count: 1, $items: [{ $ref: 901n }] });
  });

  test('Query retains its separate sparse count header', () => {
    const g = new ObjectGraph();
    feed(g, defType(20, 'Sooloos.Broker.Api.Query<Sooloos.Broker.Api.AlbumLite>', []));
    feed(g, encodeRequest(3, Buffer.from('631401020087058706', 'hex'), null));
    expect(g.getObject(99n)!.fields).toEqual({ $count: 2, $items: [{ $ref: 901n }, { $ref: 902n }] });
  });
});

describe('IList return values', () => {
  const ITEM = 'Sooloos.Broker.Api.RestoreItem';
  function graphWithItemType(): ObjectGraph {
    const g = new ObjectGraph();
    g.types.set(5, { id: 5, name: ITEM, members: [{ name: `string ${ITEM}::BackupName`, propType: PropertyType.String }] });
    return g;
  }
  /** IList<T> return value: flexInt(len) + flexInt(count) + one Object-encoded value per item. */
  function listPayload(): Buffer {
    const fields = new BinaryWriter().flexInt(1).string('b_20260101000000').flexInt(0).toBuffer();
    const body = new BinaryWriter().flexInt(2)
      .long(1).integer(5).integer(fields.length).bytes(fields) // inline struct
      .long(42) // object reference
      .toBuffer();
    return new BinaryWriter().flexInt(body.length).bytes(body).toBuffer();
  }

  test('decodeListReturnValue decodes inline structs and object references', () => {
    const items = graphWithItemType().decodeListReturnValue(listPayload());
    expect(items).toEqual([{ $type: ITEM, [`string ${ITEM}::BackupName`]: 'b_20260101000000' }, { $ref: 42n }]);
  });

  test('length mismatches and trailing bytes throw instead of returning partial results', () => {
    const payload = listPayload();
    expect(() => graphWithItemType().decodeListReturnValue(payload.subarray(0, payload.length - 1))).toThrow();
    const padded = Buffer.concat([new BinaryWriter().flexInt(payload.length).toBuffer(), payload.subarray(1), Buffer.from([0])]);
    expect(() => graphWithItemType().decodeListReturnValue(padded)).toThrow();
  });
});
