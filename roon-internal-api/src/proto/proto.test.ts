import { writeFlexInt, readFlexInt, writeFlexLong, readFlexLong } from './flex';
import { BinaryWriter } from './writer';

const hex = (a: number[]) => Buffer.from(a).toString('hex');

describe('flex varint (ported from RemotingUtils)', () => {
  test('known wire constants from captured favorite call', () => {
    const fi = (v: number) => {
      const o: number[] = [];
      writeFlexInt(o, v);
      return hex(o);
    };
    expect(fi(143)).toBe('810f'); // FavoriteOrBan name length
    expect(fi(544)).toBe('8420'); // FavoriteOrBan methodId
    expect(fi(26)).toBe('1a'); // call body length
    expect(fi(46)).toBe('2e'); // Library service objectId
    expect(fi(0)).toBe('00');
    expect(fi(127)).toBe('7f');
    expect(fi(128)).toBe('8100');
  });

  test('flexInt round-trips across boundaries', () => {
    for (const v of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 0x7fffffff]) {
      const o: number[] = [];
      writeFlexInt(o, v);
      const [back] = readFlexInt(Uint8Array.from(o), 0);
      expect(back).toBe(v >>> 0);
    }
  });

  test('flexLong round-trips and matches track objectId on wire', () => {
    // a1 8c 67 was the TrackBase objectId in the from-start capture
    const [val] = readFlexLong(Uint8Array.from([0xa1, 0x8c, 0x67]), 0);
    const o: number[] = [];
    writeFlexLong(o, val);
    expect(hex(o)).toBe('a18c67');
    for (const v of [0n, 1n, 127n, 128n, 546407n, 9007199254740993n]) {
      const oo: number[] = [];
      writeFlexLong(oo, v);
      const [back] = readFlexLong(Uint8Array.from(oo), 0);
      expect(back).toBe(v);
    }
  });
});

describe('RemotingUtils string/sooid encoding', () => {
  test('string is integer(len)+utf8', () => {
    const w = new BinaryWriter();
    w.string('production');
    expect(w.toBuffer().toString('hex')).toBe('0a' + Buffer.from('production').toString('hex'));
  });

  test('FavoriteOrBan DEFMETHOD body == captured bytes', () => {
    // Captured: 06 [bodyLen] <body>; body = flexInt(methodId=544) + WriteString(name)
    const name =
      'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)';
    const w = new BinaryWriter();
    w.flexInt(544).string(name);
    const body = w.toBuffer();
    // body should start 84 20 81 0f (methodId, then name length 143)
    expect(body.subarray(0, 4).toString('hex')).toBe('8420810f');
    expect(body.length).toBe(2 + 2 + 143); // methodId(2)+len(2)+name(143)
  });
});

describe('full FavoriteOrBan call body matches captured wire', () => {
  test('objectId + methodId + (sooid, trackRef, state)', () => {
    // Captured call body (after the 43 07 1a frame header): 2e 8420 12<18b sooid> a18c67 01
    const sooidValue = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex'); // 18 bytes
    expect(sooidValue.length).toBe(18);
    const w = new BinaryWriter();
    w.long(46) // objectId (Library service)
      .flexInt(544) // methodId (FavoriteOrBan)
      .sooid(sooidValue) // arg1: profile Sooid -> 12 + 18 bytes
      .long(BigInt(0xa1 * 0)) // placeholder replaced below
    ;
    // Rebuild precisely: objectId, methodId, sooid, trackObjId(flexlong), state(byte)
    const [trackId] = readFlexLong(Uint8Array.from([0xa1, 0x8c, 0x67]), 0);
    const call = new BinaryWriter()
      .long(46)
      .flexInt(544)
      .sooid(sooidValue)
      .long(trackId)
      .byte(0x01)
      .toBuffer();
    expect(call.toString('hex')).toBe('2e8420123f01162027273a55d64bbf4a85f335410e2fa18c6701');
  });
});
