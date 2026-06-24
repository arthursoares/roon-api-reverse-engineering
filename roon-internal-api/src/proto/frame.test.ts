import { encodeRequest, encodeResponse, FrameParser } from './frame';

const hex = (b: Buffer) => b.toString('hex');

describe('frame codec (ported from RemotingBaseProtocol)', () => {
  test('encodeRequest matches captured DEFMETHOD/CALL headers', () => {
    // DEFMETHOD (cmd 6, no response): 06 <bodyLen> <body>
    const def = encodeRequest(6, Buffer.from('8420810f', 'hex'), null);
    expect(hex(def)).toBe('06' + '04' + '8420810f');

    // CALL (cmd 3, expects response, rid 7): 43 07 <bodyLen> <body>
    const body = Buffer.from('2e8420', 'hex');
    const call = encodeRequest(3, body, 7);
    expect(hex(call)).toBe('43' + '07' + '03' + '2e8420');
  });

  test('encodeResponse matches captured c0 ack (final, empty body)', () => {
    // c0 09 00 == response+final, rid 9, empty body
    expect(hex(encodeResponse(9, Buffer.alloc(0), true))).toBe('c00900');
  });

  test('parser decodes the real captured favorite call frame', () => {
    // 43 07 1a <26-byte body> — the from-start favorite call
    const wire = Buffer.from(
      '43071a2e8420123f01162027273a55d64bbf4a85f335410e2fa18c6701',
      'hex'
    );
    const [f] = new FrameParser().push(wire);
    expect(f.isResponse).toBe(false);
    expect(f.cmd).toBe(3);
    expect(f.rid).toBe(7);
    expect(f.body.length).toBe(26);
    expect(hex(f.body)).toBe('2e8420123f01162027273a55d64bbf4a85f335410e2fa18c6701');
  });

  test('parser handles TCP coalescing and splitting', () => {
    const a = encodeRequest(3, Buffer.from('aa', 'hex'), 1);
    const b = encodeResponse(1, Buffer.from('bbbb', 'hex'));
    const both = Buffer.concat([a, b]);

    // coalesced: both frames in one push
    const parser1 = new FrameParser();
    const frames = parser1.push(both);
    expect(frames.length).toBe(2);
    expect(frames[0].rid).toBe(1);
    expect(frames[1].isResponse).toBe(true);

    // split: feed byte-by-byte, exactly 2 frames emerge
    const parser2 = new FrameParser();
    const collected = [];
    for (const byte of both) collected.push(...parser2.push(Buffer.from([byte])));
    expect(collected.length).toBe(2);
    expect(collected[1].body.toString('hex')).toBe('bbbb');
  });

  test('round-trips a c0 final ack', () => {
    const [f] = new FrameParser().push(Buffer.from('c00900', 'hex'));
    expect(f.isResponse).toBe(true);
    expect(f.isFinal).toBe(true);
    expect(f.rid).toBe(9);
    expect(f.body.length).toBe(0);
  });
});
