import * as fs from 'fs';
import * as path from 'path';
import { Arg, buildArgs, inlineStruct, serializeStructValue } from '../proto/serializer';
import { BinaryReader } from '../proto/reader';
import { ObjectGraph, PropertyType } from '../proto/objects';
import { formatMethodSignature } from '../catalog/signature';

const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'catalog', 'catalog.json'), 'utf8')
);

/**
 * Phase 3 — encoding breadth validation (non-destructive).
 * 1. Every Arg kind round-trips through buildArgs + BinaryReader.
 * 2. Every PropertyType struct value round-trips through ObjectGraph.decodeReturnValue.
 * 3. Every catalog method formats a well-formed DEFMETHOD signature.
 */

describe('Arg kind breadth round-trip (Phase 3)', () => {
  const r = (b: Buffer) => new BinaryReader(Uint8Array.from(b));

  test('sooid round-trips', () => {
    const sooid = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');
    expect(r(buildArgs([Arg.sooid(sooid)])).sooid().toString('hex')).toBe(sooid.toString('hex'));
  });

  test('ref round-trips as flexLong oid', () => {
    const out = buildArgs([Arg.ref(123456789012n)]);
    expect(r(out).long()).toBe(123456789012n);
  });

  test('refList round-trips count + oids', () => {
    const out = buildArgs([Arg.refList([10n, 20n, 30n])]);
    const rd = r(out);
    expect(rd.flexInt()).toBe(3);
    expect(rd.long()).toBe(10n);
    expect(rd.long()).toBe(20n);
    expect(rd.long()).toBe(30n);
  });

  test('enum round-trips as flexInt', () => {
    expect(r(buildArgs([Arg.enum_(256)])).flexInt()).toBe(256);
  });

  test('str/bool/int/long/double/bytes round-trip', () => {
    expect(r(buildArgs([Arg.str('qobuz')])).string()).toBe('qobuz');
    expect(r(buildArgs([Arg.bool(true)])).boolean()).toBe(true);
    expect(r(buildArgs([Arg.int(42)])).flexInt()).toBe(42);
    expect(r(buildArgs([Arg.long(999n)])).long()).toBe(999n);
    expect(r(buildArgs([Arg.double(2.5)])).double()).toBe(2.5);
    expect(r(buildArgs([Arg.bytes(Buffer.from('deadbeef', 'hex'))])).byteArray()!.toString('hex')).toBe('deadbeef');
  });
});

describe('PropertyType struct-value breadth round-trip (Phase 3)', () => {
  // Register a synthetic TypeDef so ObjectGraph can decode an inline value object.
  function roundTrip(t: PropertyType, v: unknown): unknown {
    const graph2 = new ObjectGraph();
    graph2.types.set(7, { id: 7, name: 'Sooloos.Broker.Api.Probe', members: [{ name: 'Sooloos.Broker.Api.Probe::Field', propType: t }] });
    const val = serializeStructValue(t, v);
    const inline = inlineStruct(7, [{ index: 1, value: val }]);
    return graph2.decodeReturnValue(inline.subarray(0));
  }

  test('Int/Long/Bool/Enum/String/Double/Sooid round-trip through ObjectGraph', () => {
    // ObjectGraph keys decoded fields by the FULL DEFTYPE member name.
    const K = 'Sooloos.Broker.Api.Probe::Field';
    expect(roundTrip(PropertyType.Int, 42)).toMatchObject({ [K]: 42 });
    expect(roundTrip(PropertyType.Long, 123456789012n)).toMatchObject({ [K]: 123456789012n });
    expect(roundTrip(PropertyType.Bool, true)).toMatchObject({ [K]: true });
    expect(roundTrip(PropertyType.Enum, 256)).toMatchObject({ [K]: 256 });
    expect(roundTrip(PropertyType.String, 'qobuz')).toMatchObject({ [K]: 'qobuz' });
    expect(roundTrip(PropertyType.Double, 1.5)).toMatchObject({ [K]: 1.5 });
    expect(roundTrip(PropertyType.Sooid, Buffer.from('3f0116', 'hex'))).toMatchObject({ [K]: Buffer.from('3f0116', 'hex') });
  });

  test('serializeStructValue covers the settable PropertyTypes without throwing', () => {
    const cases: [PropertyType, unknown][] = [
      [PropertyType.Int, 42],
      [PropertyType.Long, 123456789012n],
      [PropertyType.Bool, true],
      [PropertyType.Enum, 3],
      [PropertyType.String, 'joão'],
      [PropertyType.Double, 1.5],
      [PropertyType.Sooid, Buffer.from('3f0116', 'hex')],
      [PropertyType.ByteArray, Buffer.from('aa', 'hex')],
      [PropertyType.NullableBool, null],
    ];
    for (const [t, v] of cases) {
      expect(() => serializeStructValue(t, v)).not.toThrow();
    }
  });
});

describe('catalog method signature breadth (Phase 3)', () => {
  test('every catalog method formats a well-formed DEFMETHOD signature', () => {
    let total = 0;
    const bad: string[] = [];
    for (const [service, methods] of Object.entries<any[]>(catalog.services)) {
      const svc = service.replace(/<.*>$/, '');
      for (const m of methods) {
        total++;
        const sig = formatMethodSignature(svc, m.name, m.params);
        if (!sig.startsWith('Sooloos.Broker.Api.') || !sig.includes('::' + m.name + '(')) {
          bad.push(sig);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(1500);
  });
});
