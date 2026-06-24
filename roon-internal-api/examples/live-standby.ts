/**
 * Power a zone's device on/off via its source control (standby).
 *   npx ts-node examples/live-standby.ts HiFi          # report standby support/state
 *   npx ts-node examples/live-standby.ts HiFi off      # Endpoint::Standby()  (power off)
 *   npx ts-node examples/live-standby.ts HiFi on        # Endpoint::ConvenienceSwitch() (power on)
 *   npx ts-node examples/live-standby.ts HiFi toggle    # Endpoint::ToggleStandby()
 */
import { RoonConnection } from '../src/proto/connection';
import { RemotingClient } from '../src/proto/remoting';
import { ObjectGraph, RoonObject } from '../src/proto/objects';
import { formatMethodSignature } from '../src/catalog/signature';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

const NAME = process.argv[2] || 'HiFi';
const ACTION = process.argv[3]; // off | on | toggle | (none = report)

const fget = (o: RoonObject, suf: string) => {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suf)) return v;
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

  const ep = graph
    .findByType('Endpoint')
    .find((e) => String(fget(e, '::Name') ?? '').toLowerCase().includes(NAME.toLowerCase()));
  if (!ep) throw new Error(`endpoint "${NAME}" not found`);

  console.log(`Endpoint "${fget(ep, '::Name')}" oid=${ep.oid}`);
  console.log(`  SupportsStandby      = ${fget(ep, '::SupportsStandby')}`);
  console.log(`  IsStandby            = ${fget(ep, '::IsStandby')}`);
  console.log(`  SupportsSourceControls = ${fget(ep, '::SupportsSourceControls')}`);
  console.log(`  SourceControls       = ${JSON.stringify(fget(ep, '::SourceControls'), (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`);

  if (!ACTION) {
    console.log('\n(report only — pass off | on | toggle to act)');
    conn.close();
    return;
  }

  const method = ACTION === 'on' ? 'ConvenienceSwitch' : ACTION === 'toggle' ? 'ToggleStandby' : 'Standby';
  // ConvenienceSwitch takes a ResultCallback; Standby/ToggleStandby are fire-and-forget.
  if (method === 'ConvenienceSwitch') {
    const sig = formatMethodSignature('Endpoint', 'ConvenienceSwitch', [
      { type: 'ResultCallback', name: 'cb' },
    ]);
    const res = await client.callMethod(ep.oid, sig, Buffer.alloc(0));
    console.log(`\n${method} -> status "${res.status}" (success=${res.success})`);
  } else {
    const sig = formatMethodSignature('Endpoint', method, []);
    client.callMethodNoReply(ep.oid, sig, Buffer.alloc(0));
    console.log(`\nSent Endpoint::${method}() to "${fget(ep, '::Name')}".`);
  }
  await new Promise((r) => setTimeout(r, 800));
  conn.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
