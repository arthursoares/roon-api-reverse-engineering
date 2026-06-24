import { ObjectGraph, PropertyType, isRef } from './objects';
import { encodeRequest, FrameParser } from './frame';
import { BinaryWriter } from './writer';
import { writeFlexInt } from './flex';

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
