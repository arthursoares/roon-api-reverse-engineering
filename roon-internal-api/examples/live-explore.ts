/**
 * READ-ONLY live exploration: connect, build the object graph, and list
 * favoritable albums/tracks (title + current favorite state + oid) so we have a
 * verifiable target for the first live favorite. No mutations.
 */
import { RoonConnection } from '../src/proto/connection';
import { RemotingClient } from '../src/proto/remoting';
import { ObjectGraph, RoonObject } from '../src/proto/objects';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

function field(o: RoonObject, suffix: string): unknown {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix)) return v;
  return undefined;
}

async function main() {
  const conn = new RoonConnection({ host: HOST, serverBrokerId: SERVER_BROKER_ID });
  const client = new RemotingClient(conn);
  const graph = new ObjectGraph();
  client.onPush = (f) => graph.ingest(f);

  await conn.connect();
  const root = await client.getService(ROOT_SERVICE_GUID);
  console.log(`connected; root oid=${root}`);
  await new Promise((r) => setTimeout(r, 2000)); // let the object graph settle

  console.log(`types=${graph.types.size} objects=${graph.objects.size}`);
  for (const svc of ['Library', 'Transport', 'Zone']) {
    const m = graph.findByType(svc);
    if (m.length) console.log(`${svc}: oid=${m.map((o) => o.oid).join(',')}`);
  }

  for (const typeName of ['AlbumLite', 'Album', 'TrackLite', 'Track', 'WorkLite']) {
    const objs = graph.findByType(typeName).filter((o) => field(o, '::Title') !== undefined);
    if (!objs.length) continue;
    console.log(`\n${typeName}: ${objs.length} with titles`);
    for (const o of objs.slice(0, 8)) {
      const title = field(o, '::Title');
      const fav = field(o, '::IsFavorite');
      console.log(`  oid=${o.oid}  fav=${fav}  ${JSON.stringify(title)}`);
    }
  }

  conn.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
