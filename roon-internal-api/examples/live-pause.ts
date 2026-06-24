/**
 * Pause (or stop) a named zone:  npx ts-node examples/live-pause.ts HiFi [stop]
 * Zone::Pause()/Stop() are fire-and-forget methods on the Zone object.
 */
import { RoonConnection } from '../src/proto/connection';
import { RemotingClient } from '../src/proto/remoting';
import { ObjectGraph, RoonObject, isRef } from '../src/proto/objects';
import { formatMethodSignature } from '../src/catalog/signature';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

const ZONE_NAME = process.argv[2] || 'HiFi';
const METHOD = process.argv[3] === 'stop' ? 'Stop' : 'Pause';

const strField = (o: RoonObject, suf: string) => {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suf) && typeof v === 'string') return v as string;
  return undefined;
};

async function main() {
  const conn = new RoonConnection({ host: HOST, serverBrokerId: SERVER_BROKER_ID });
  const client = new RemotingClient(conn);
  const graph = new ObjectGraph();
  client.onPush = (f) => graph.ingest(f);
  await conn.connect();
  await client.getService(ROOT_SERVICE_GUID);
  await new Promise((r) => setTimeout(r, 2000));

  // resolve zone via endpoint name -> Zone ref
  let zoneOid: bigint | undefined;
  for (const e of graph.findByType('Endpoint')) {
    if (strField(e, '::Name')?.toLowerCase().includes(ZONE_NAME.toLowerCase())) {
      for (const [k, v] of Object.entries(e.fields)) if (k.endsWith('::Zone') && isRef(v)) zoneOid = (v as any).$ref;
    }
  }
  if (zoneOid === undefined) throw new Error(`zone "${ZONE_NAME}" not found`);

  const sig = formatMethodSignature('Zone', METHOD, []);
  client.callMethodNoReply(zoneOid, sig, Buffer.alloc(0));
  console.log(`Sent Zone::${METHOD}() to zone "${ZONE_NAME}" (oid=${zoneOid}).`);
  await new Promise((r) => setTimeout(r, 600));
  conn.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
