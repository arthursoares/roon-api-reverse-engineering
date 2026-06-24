/**
 * Read editable album metadata (Phase E, read side) via Library::GetAlbumEditInfo.
 * The result is an inline by-value AlbumEditInfo struct (decoded from the response,
 * not pushed into the graph). Read-only and safe.
 *
 *   npx ts-node examples/album-edit-info.ts
 */
import { RoonClient } from '../src/index';
import { RoonObject } from '../src/proto/objects';

function titleOf(o: RoonObject): string | undefined {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith('::Title') && typeof v === 'string') return v;
  return undefined;
}

(async () => {
  const roon = new RoonClient({
    host: process.env.ROON_HOST || 'YOUR_CORE_IP',
    serverBrokerId: Buffer.from('YOUR_SERVER_BROKER_ID', 'hex'),
  });
  await roon.connect();

  for (const album of roon.graph.findByType('AlbumLite').slice(0, 5)) {
    let info;
    try {
      info = await roon.getAlbumEditInfo(album.oid);
    } catch (e) {
      console.log(`\n${titleOf(album)}: ${(e as Error).message}`);
      continue;
    }
    console.log(`\n=== ${titleOf(album)} (oid ${album.oid}) ===`);
    console.log('  title      :', info.title.value, info.title.edited ? '(user-edited)' : '');
    console.log('  performedBy:', info.performedBy.value);
    console.log('  version    :', info.version.value);
    console.log('  genres     :', info.genres.value?.join(', '));
    console.log('  labels     :', info.labels.value?.join(', '));
    console.log('  rating     :', info.rating.value);
    console.log('  flags      :', `compilation=${info.isCompilation.value} live=${info.isLive.value} pick=${info.isPick.value} explicit=${info.containsExplicitContent.value} hidden=${info.isUserHidden.value}`);
  }
  roon.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
