/**
 * FIRST LIVE MUTATION from our own ported client: favorite an album by title.
 * Reversible (run with `unfav` to undo). Verify the heart in the Roon UI.
 *
 *   npx ts-node examples/live-favorite.ts "Clube Da Esquina"        # favorite
 *   npx ts-node examples/live-favorite.ts "Clube Da Esquina" unfav  # remove
 */
import { RoonConnection } from '../src/proto/connection';
import { RemotingClient } from '../src/proto/remoting';
import { ObjectGraph, RoonObject } from '../src/proto/objects';
import { formatMethodSignature } from '../src/catalog/signature';
import { Arg, buildArgs } from '../src/proto/serializer';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');
// Profile Sooid (stable per user) — value bytes from captured Library calls.
const PROFILE_SOOID = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');

const TITLE = process.argv[2] || 'Clube Da Esquina';
const STATE = process.argv[3] === 'unfav' ? 0 : 1; // FavoriteBanState: None=0, Favorite=1, Ban=2

function title(o: RoonObject): string | undefined {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith('::Title') && typeof v === 'string') return v;
  return undefined;
}

async function main() {
  const conn = new RoonConnection({ host: HOST, serverBrokerId: SERVER_BROKER_ID });
  const client = new RemotingClient(conn);
  const graph = new ObjectGraph();
  client.onPush = (f) => graph.ingest(f);

  await conn.connect();
  await client.getService(ROOT_SERVICE_GUID);
  await new Promise((r) => setTimeout(r, 2000));

  const lib = graph.findByType('Library')[0];
  if (!lib) throw new Error('Library object not found');

  // Find an Album/AlbumLite with the requested title.
  const albums = [...graph.findByType('AlbumLite'), ...graph.findByType('Album')];
  const target = albums.find((o) => title(o)?.toLowerCase() === TITLE.toLowerCase());
  if (!target) {
    console.log(`Album "${TITLE}" not in the current object graph. Available albums:`);
    for (const a of albums) console.log(`  - ${title(a)}`);
    throw new Error('target album not loaded; open it in Roon or pick one of the above');
  }

  console.log(`Library oid=${lib.oid}; target album "${title(target)}" oid=${target.oid}`);
  console.log(`Action: ${STATE === 1 ? 'FAVORITE' : 'REMOVE FAVORITE'}`);

  const sig = formatMethodSignature('Library', 'FavoriteOrBan', [
    { type: 'Sooid', name: 'profileid' },
    { type: 'AlbumBase', name: 'album' },
    { type: 'FavoriteBanState', name: 'state' },
    { type: 'ResultCallback', name: 'cb_result' },
  ]);
  const args = buildArgs([Arg.sooid(PROFILE_SOOID), Arg.ref(target.oid), Arg.enum_(STATE)]);

  const res = await client.callMethod(lib.oid, sig, args);
  console.log(`\nServer status: "${res.status}"  (success=${res.success})`);
  if (res.success) {
    console.log(`\n*** ${STATE === 1 ? 'FAVORITED' : 'UNFAVORITED'} "${title(target)}" — check the heart in Roon. ***`);
  }
  await new Promise((r) => setTimeout(r, 500));
  conn.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
