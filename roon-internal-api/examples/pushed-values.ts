/** READ-ONLY: decode the actually-pushed AlbumLite/TrackLite values (Source, ImportDate/AddedTime). */
import { RoonClient } from '../src/proto/client';

const HOST = process.env.ROON_HOST || '192.168.178.30';
const BROKER = Buffer.from(process.env.ROON_BROKER || '465f021738d44b46bbe84c20a05a313b', 'hex');
const TICKS_EPOCH = 621355968000000000n;

function dt(ticks: unknown): string | null {
  if (typeof ticks !== 'bigint' || ticks === 0n) return null;
  // .NET DateTime binary: top 2 bits = DateTimeKind; mask them off to get ticks.
  const t = ticks & 0x3fffffffffffffffn;
  const ms = Number((t - TICKS_EPOCH) / 10000n);
  return new Date(ms).toISOString();
}

function val(o: Record<string, unknown>, suffix: string): unknown {
  for (const [k, v] of Object.entries(o)) if (k.includes('::' + suffix)) return v;
  return undefined;
}

async function main(): Promise<void> {
  const roon = new RoonClient({ host: HOST, serverBrokerId: BROKER });
  await roon.connect();
  console.log(`objects=${roon.graph.objects.size}`);
  for (const t of ['AlbumLite', 'TrackLite']) {
    const objs = roon.graph.findByType(t);
    console.log(`\n${t}: ${objs.length}`);
    for (const o of objs) {
      const title = val(o.fields, 'Title');
      const src = val(o.fields, 'Source');
      const csrc = val(o.fields, 'ContentSource');
      const imp = val(o.fields, 'ImportDate');
      const added = val(o.fields, 'AddedTime');
      const dls = val(o.fields, 'IsDownloadSupported');
      console.log(`  oid=${o.oid} Title=${JSON.stringify(title)} Source=${src} ContentSource=${csrc} ImportDate=${dt(imp)} AddedTime=${dt(added)} IsDownloadSupported=${dls}`);
    }
  }
  roon.close();
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
