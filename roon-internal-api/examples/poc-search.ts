/**
 * Dumb POC: search Roon, show results in a table, play a chosen result on a
 * chosen zone. One interactive session (object ids are session-scoped).
 *
 *   npx ts-node examples/poc-search.ts
 */
import * as readline from 'readline';
import { RoonClient } from '../src/proto/client';
import { RoonObject } from '../src/proto/objects';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

const kind = (o: RoonObject) => {
  const n = o.typeName.split('.').pop()!;
  return n.replace('Lite', '');
};
const isPlayableAlbum = (o: RoonObject) => o.typeName.endsWith('AlbumLite');
const isPlayableTrack = (o: RoonObject) => o.typeName.endsWith('TrackLite');

async function main() {
  const roon = new RoonClient({
    host: process.env.ROON_HOST || 'YOUR_CORE_IP',
    serverBrokerId: Buffer.from('YOUR_SERVER_BROKER_ID', 'hex'),
  });
  console.log('Connecting…');
  await roon.connect();

  // list zones once
  const zoneNames: string[] = [];
  for (const e of roon.graph.findByType('Endpoint')) {
    const nm = (() => {
      for (const [k, v] of Object.entries(e.fields)) if (k.endsWith('::Name') && typeof v === 'string') return v as string;
      return undefined;
    })();
    if (nm && roon.zoneByName(nm)) zoneNames.push(nm);
  }
  console.log('Zones:', zoneNames.join(', '));

  for (;;) {
    const term = (await ask('\nSearch (or "q" to quit): ')).trim();
    if (!term || term === 'q') break;

    process.stdout.write('Searching…\n');
    const results = await roon.search(term);
    const rows = results.filter((o) => isPlayableAlbum(o) || isPlayableTrack(o));
    if (!rows.length) {
      console.log('No playable album/track results. (Performers/works may still have matched.)');
      continue;
    }

    console.log('\n  #  | Type   | Title');
    console.log('-----+--------+------------------------------------------');
    rows.forEach((o, i) => {
      console.log(` ${String(i).padStart(3)} | ${kind(o).padEnd(6)} | ${roon.titleOf(o)}`);
    });

    const pick = (await ask('\nPlay which # (Enter to skip): ')).trim();
    if (pick === '') continue;
    const idx = Number(pick);
    const chosen = rows[idx];
    if (!chosen) {
      console.log('invalid #');
      continue;
    }
    const zoneName = (await ask(`Zone [${zoneNames.join('/')}]: `)).trim();
    const zoneOid = roon.zoneByName(zoneName);
    if (zoneOid === undefined) {
      console.log(`zone "${zoneName}" not found`);
      continue;
    }

    const res = isPlayableAlbum(chosen)
      ? await roon.playAlbum(zoneOid, chosen.oid)
      : await roon.playTrack(zoneOid, chosen.oid);
    console.log(`\n${res.success ? '▶ playing' : '✗ failed'} "${roon.titleOf(chosen)}" on ${zoneName} — status "${res.status}"`);
  }

  roon.close();
  rl.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  rl.close();
  process.exit(1);
});
