/**
 * Phase D: searchAlbums returns real album results (READ-ONLY).
 *   npx ts-node examples/search-albums.ts Clube
 *
 * Returns library albums whose title matches the term (harvested from the live
 * object graph + a UnifiedSearch trigger). Live-validated: Saudades, Clube Da
 * Esquina, A Tábua de Esmeralda, Sleep all return their album.
 */
import { RoonClient } from '../src/proto/client';

(async () => {
  const roon = new RoonClient({
    host: process.env.ROON_HOST || 'YOUR_CORE_IP',
    serverBrokerId: Buffer.from('YOUR_SERVER_BROKER_ID', 'hex'),
  });
  await roon.connect();
  const term = process.argv[2] || 'Clube';
  const albums = await roon.searchAlbums(term);
  console.log(`searchAlbums("${term}") -> ${albums.length} result(s):`);
  for (const a of albums) console.log(`  "${roon.titleOf(a)}"  oid=${a.oid}`);
  roon.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
