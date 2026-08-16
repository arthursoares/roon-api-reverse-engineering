/**
 * READ-ONLY: pull a full Album + TrackLite object so the server DEFTYPEs the
 * full entity types, then dump their complete member/field-name inventory.
 * No mutations.
 */
import { RoonClient } from '../src/proto/client';
import { Arg, buildArgs } from '../src/proto/serializer';

const HOST = process.env.ROON_HOST || '192.168.178.30';
const BROKER = Buffer.from(process.env.ROON_BROKER || '465f021738d44b46bbe84c20a05a313b', 'hex');

async function main(): Promise<void> {
  const roon = new RoonClient({ host: HOST, serverBrokerId: BROKER });
  await roon.connect();
  console.log(`connected; types=${roon.graph.types.size} objects=${roon.graph.objects.size}`);

  const lib = roon.serviceOid('Library');
  // Use the sample AlbumLite's internal AlbumId + TrackLite's TrackId.
  const al = roon.graph.findByType('AlbumLite')[0];
  const tl = roon.graph.findByType('TrackLite')[0];
  const albumId = (al!.fields['long Sooloos.Broker.Api.AlbumLite::AlbumId'] as bigint).toString();
  const trackId = (tl!.fields['long Sooloos.Broker.Api.TrackLite::TrackId'] as bigint).toString();
  console.log(`sample albumId=${albumId} trackId=${trackId}`);

  const sigAlbum = 'Sooloos.Broker.Api.Library::GetAlbum(long, Base.ResultCallback<Sooloos.Broker.Api.Album>)';
  const sigTrack = 'Sooloos.Broker.Api.Library::GetTrackLite(long, Base.ResultCallback<Sooloos.Broker.Api.TrackLite>)';
  const r1 = await roon.remoting.callMethod(lib, sigAlbum, buildArgs([Arg.long(BigInt(albumId))]));
  const r2 = await roon.remoting.callMethod(lib, sigTrack, buildArgs([Arg.long(BigInt(trackId))]));
  console.log(`GetAlbum status=${r1.status} payload=${r1.payload.length}B`);
  console.log(`GetTrackLite status=${r2.status} payload=${r2.payload.length}B`);
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`types now=${roon.graph.types.size} objects=${roon.graph.objects.size}`);
  for (const short of ['Album', 'Track', 'AlbumLite', 'TrackLite']) {
    const defs = [...roon.graph.types.values()].filter((d) => d.name.endsWith(short));
    if (!defs.length) { console.log(`\n== SCHEMA ${short}: none ==`); continue; }
    for (const d of defs) {
      console.log(`\n== SCHEMA ${d.name} (typeId=${d.id}, ${d.members.length} members) ==`);
      for (const m of d.members) console.log(`   ${m.name} (propType ${m.propType})`);
    }
  }
  roon.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
