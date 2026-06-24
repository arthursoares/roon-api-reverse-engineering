import { RemotingClient, Cmd, Transport } from './remoting';
import { FrameParser, encodeResponse } from './frame';
import { BinaryWriter } from './writer';

class MockTransport implements Transport {
  sent: Buffer[] = [];
  private handler: (c: Buffer) => void = () => {};
  send(data: Buffer) {
    this.sent.push(data);
  }
  onData(h: (c: Buffer) => void) {
    this.handler = h;
  }
  /** Simulate bytes arriving from the server. */
  deliver(data: Buffer) {
    this.handler(data);
  }
  /** Parse everything sent so far back into frames for assertions. */
  sentFrames() {
    const p = new FrameParser();
    return p.push(Buffer.concat(this.sent));
  }
}

const SIG = 'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)';

describe('RemotingClient (ported from RemotingClientV2)', () => {
  test('first call emits DEFMETHOD then CALL; structure matches the protocol', async () => {
    const t = new MockTransport();
    const c = new RemotingClient(t);

    const args = new BinaryWriter()
      .sooid(Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex'))
      .long(BigInt(0x115c67)) // a track object id
      .byte(1) // FavoriteBanState.Favorite
      .toBuffer();

    const promise = c.callMethod(46n, SIG, args);

    const frames = t.sentFrames();
    expect(frames.length).toBe(2);

    // 1) DEFMETHOD (cmd 6, no rid): body = flexInt(methodId=1) + string(sig)
    expect(frames[0].cmd).toBe(Cmd.DEFMETHOD);
    expect(frames[0].isResponse).toBe(false);
    expect(frames[0].rid).toBeNull();
    expect(frames[0].body[0]).toBe(1); // methodId 1 (we assign our own ids)
    expect(frames[0].body.subarray(3).toString('utf8')).toContain('FavoriteOrBan');

    // 2) CALL (cmd 3, has rid): body = flexLong(46) + flexInt(1) + args
    expect(frames[1].cmd).toBe(Cmd.CALL);
    expect(frames[1].rid).not.toBeNull();
    expect(frames[1].body[0]).toBe(46); // objectId
    expect(frames[1].body[1]).toBe(1); // methodId
    expect(frames[1].body.subarray(2).toString('hex')).toBe(args.toString('hex'));

    // Deliver a Success response (status string '' then empty payload).
    const respBody = new BinaryWriter().string('').toBuffer();
    t.deliver(encodeResponse(frames[1].rid!, respBody, true));

    const res = await promise;
    expect(res.status).toBe(''); // Success
  });

  test('second call to same signature reuses the method id (no second DEFMETHOD)', async () => {
    const t = new MockTransport();
    const c = new RemotingClient(t, 50); // short timeout so dangling calls clean up
    const ignore = () => {};
    c.callMethod(46n, SIG, Buffer.alloc(0)).catch(ignore);
    const firstCount = t.sent.length; // DEFMETHOD + CALL = 2
    c.callMethod(46n, SIG, Buffer.alloc(0)).catch(ignore);
    expect(t.sent.length).toBe(firstCount + 1); // only a CALL this time

    const frames = t.sentFrames();
    const defmethods = frames.filter((f) => f.cmd === Cmd.DEFMETHOD);
    expect(defmethods.length).toBe(1);
  });

  test('getService parses status + object id', async () => {
    const t = new MockTransport();
    const c = new RemotingClient(t);
    const guid = Buffer.alloc(16, 7);
    const p = c.getService(guid);
    const f = t.sentFrames()[0];
    expect(f.cmd).toBe(Cmd.GETSVC);
    // respond: string('') + flexLong(46)
    const body = new BinaryWriter().string('').long(46).toBuffer();
    t.deliver(encodeResponse(f.rid!, body, true));
    expect(await p).toBe(46n);
  });

  test('server PING is auto-acked', () => {
    const t = new MockTransport();
    new RemotingClient(t); // wires itself to the transport
    // inbound PING request expecting a response, rid 5
    const { encodeRequest } = require('./frame');
    t.deliver(encodeRequest(Cmd.PING, Buffer.alloc(0), 5));
    const reply = t.sentFrames()[0];
    expect(reply.isResponse).toBe(true);
    expect(reply.rid).toBe(5);
  });
});
