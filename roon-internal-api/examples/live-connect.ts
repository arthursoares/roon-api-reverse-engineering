/**
 * Live end-to-end test of the ported stack (READ-ONLY, safe):
 *   RoonConnection (handshake) -> RemotingClient -> getService(root)
 * Validates that our TypeScript port can establish a real remoting session and
 * receive the server's object/type graph. No mutations, no audio.
 */
import { RoonConnection } from '../src/proto/connection';
import { RemotingClient, Cmd } from '../src/proto/remoting';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
// Root service guid (captured GETSVC); stable service id, reused verbatim.
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function main() {
  const conn = new RoonConnection({ host: HOST, serverBrokerId: SERVER_BROKER_ID });
  const client = new RemotingClient(conn);

  const pushCounts: Record<number, number> = {};
  let deftypeNames = 0;
  client.onPush = (frame) => {
    pushCounts[frame.cmd] = (pushCounts[frame.cmd] || 0) + 1;
    // DEFTYPE frames carry type-name strings; count them as a schema sanity check.
    if (frame.cmd === Cmd.DEFTYPE && frame.body.includes(Buffer.from('Sooloos.Broker.Api'))) {
      deftypeNames++;
    }
  };

  console.log(`Connecting to ${HOST}:9332 ...`);
  await conn.connect();
  console.log('Handshake + ConnectRequest OK — remoting layer is live.');

  console.log('Calling getService(root) ...');
  const oid = await client.getService(ROOT_SERVICE_GUID);
  console.log(`\n*** getService resolved: root service objectId = ${oid} ***`);

  // Let any trailing schema pushes settle.
  await new Promise((r) => setTimeout(r, 1500));
  console.log('\nServer push frame counts by cmd:', pushCounts);
  console.log('DEFTYPE frames naming Sooloos.Broker.Api types:', deftypeNames);

  conn.close();
  console.log('\nDone. Full ported stack established a live remoting session and read the type graph.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
