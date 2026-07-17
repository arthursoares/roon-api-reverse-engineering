/**
 * Demo of the RoonClient facade — how short a PoC is now (read-only here).
 *   npx ts-node examples/demo.ts
 */
import { RoonClient } from '../src/proto/client';

async function main() {
  const roon = new RoonClient({
    host: process.env.ROON_HOST || 'YOUR_CORE_IP',
    serverBrokerId: Buffer.from('YOUR_SERVER_BROKER_ID', 'hex'),
  });
  await roon.connect();

  console.log('Library oid:', roon.serviceOid('Library').toString());
  console.log('Transport oid:', roon.serviceOid('Transport').toString());
  console.log('HiFi zone oid:', roon.zoneByName('HiFi')?.toString());

  const album = roon.findByTitle('AlbumLite', 'Clube Da Esquina');
  console.log('Found album "Clube Da Esquina":', album ? `oid=${album.oid}` : 'not loaded');

  // Everything below is one-liners (left commented so the demo stays read-only):
  //   if (album) await roon.favoriteAlbum(roon.albumIdOf(album)!, true);
  //   await roon.playAlbumOnZone('HiFi', 'Clube Da Esquina');
  //   roon.zoneControl(roon.zoneByName('HiFi')!, 'Pause');
  //   roon.standby(roon.endpointByName('HiFi')!);

  roon.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
