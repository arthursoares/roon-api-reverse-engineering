/**
 * Live playback on a named zone.
 *   npx ts-node examples/live-play.ts                          # list zones + albums
 *   npx ts-node examples/live-play.ts HiFi "Clube Da Esquina" play   # PlayAlbum
 *
 * Uses Transport::PlayAlbum(Zone, Sooid, PlayParameters, AlbumBase, bool, bool, cb).
 * PlayParameters is sent empty (just the sparse 0-terminator) = server defaults.
 */
import { RoonConnection } from '../src/proto/connection';
import { RemotingClient } from '../src/proto/remoting';
import { ObjectGraph, RoonObject } from '../src/proto/objects';
import { formatMethodSignature } from '../src/catalog/signature';
import { Arg, buildArgs, inlineStruct } from '../src/proto/serializer';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');
const PROFILE_SOOID = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');

const ZONE_NAME = process.argv[2];
const ALBUM_TITLE = process.argv[3];
const DO_PLAY = process.argv[4] === 'play';

const strField = (o: RoonObject, suffix: string): string | undefined => {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && typeof v === 'string') return v;
  return undefined;
};
const anyName = (o: RoonObject): string | undefined =>
  strField(o, '::DisplayName') || strField(o, '::Name') || strField(o, '::Title');

async function main() {
  const conn = new RoonConnection({ host: HOST, serverBrokerId: SERVER_BROKER_ID });
  const client = new RemotingClient(conn);
  const graph = new ObjectGraph();
  client.onPush = (f) => graph.ingest(f);

  await conn.connect();
  await client.getService(ROOT_SERVICE_GUID);
  await new Promise((r) => setTimeout(r, 2000));

  // Zones have no name field; they're named via their endpoints (Endpoint::Name
  // -> Endpoint::Zone ref). Build endpointName -> zoneOid.
  const zoneByEndpointName = new Map<string, bigint>();
  for (const e of graph.findByType('Endpoint')) {
    const nm = strField(e, '::Name');
    let zoneOid: bigint | undefined;
    for (const [k, v] of Object.entries(e.fields)) {
      if (k.endsWith('::Zone') && v && typeof v === 'object' && '$ref' in (v as object)) {
        zoneOid = (v as any).$ref;
      }
    }
    if (nm && zoneOid !== undefined) zoneByEndpointName.set(nm, zoneOid);
  }
  const zones = graph.findByType('Zone');
  console.log('Zones (by endpoint name):');
  for (const [nm, oid] of zoneByEndpointName) console.log(`  "${nm}" -> zone oid=${oid}`);

  if (!DO_PLAY || !ZONE_NAME || !ALBUM_TITLE) {
    const albums = [...graph.findByType('AlbumLite'), ...graph.findByType('Album')];
    console.log('\nAlbums loaded:');
    for (const a of albums) console.log(`  - ${anyName(a)}`);
    console.log('\n(dry run — pass: <ZoneName> "<AlbumTitle>" play  to actually play)');
    conn.close();
    return;
  }

  let zoneOid: bigint | undefined;
  for (const [nm, oid] of zoneByEndpointName) if (nm.toLowerCase().includes(ZONE_NAME.toLowerCase())) zoneOid = oid;
  const zone = zones.find((z) => z.oid === zoneOid);
  if (!zone) throw new Error(`zone matching "${ZONE_NAME}" not found`);
  const albums = [...graph.findByType('AlbumLite'), ...graph.findByType('Album')];
  const album = albums.find((a) => anyName(a)?.toLowerCase() === ALBUM_TITLE.toLowerCase());
  if (!album) throw new Error(`album "${ALBUM_TITLE}" not loaded`);

  const transport = graph.findByType('Transport')[0];
  console.log(`\nPlaying "${anyName(album)}" (oid=${album.oid}) on zone "${anyName(zone)}" (oid=${zone.oid})`);

  const sig = formatMethodSignature('Transport', 'PlayAlbum', [
    { type: 'Zone', name: 'zone' },
    { type: 'Sooid', name: 'profileid' },
    { type: 'PlayParameters', name: 'parameters' },
    { type: 'AlbumBase', name: 'album' },
    { type: 'bool', name: 'favoritesonly' },
    { type: 'bool', name: 'includehidden' },
    { type: 'ResultCallback<PlayFeedback>', name: 'cb_result' },
  ]);

  // PlayParameters is a by-value struct: declare it (cmd 5) and send it inline
  // as a default (empty) value object.
  const ppTypeId = client.defineType('Sooloos.Broker.Api.PlayParameters', []);
  // args: zone(ref) sooid playparams(inline struct) album(ref) bool bool
  const args = Buffer.concat([
    buildArgs([Arg.ref(zone.oid), Arg.sooid(PROFILE_SOOID)]),
    inlineStruct(ppTypeId),
    buildArgs([Arg.ref(album.oid), Arg.bool(false), Arg.bool(false)]),
  ]);

  const res = await client.callMethod(transport.oid, sig, args);
  console.log(`\nServer status: "${res.status}" (success=${res.success})`);
  await new Promise((r) => setTimeout(r, 800));
  conn.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
