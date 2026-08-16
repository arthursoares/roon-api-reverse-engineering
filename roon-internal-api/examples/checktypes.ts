import { RoonClient } from '../src/proto/client';
async function main(): Promise<void> {
  const roon = new RoonClient({ host: process.env.ROON_HOST || '192.168.178.30', serverBrokerId: Buffer.from(process.env.ROON_BROKER || '465f021738d44b46bbe84c20a05a313b', 'hex') });
  await roon.connect();
  const names = [...roon.graph.types.values()].map((d) => d.name).filter((n) => /Album|Track|Service|Broker/.test(n));
  const uniq = [...new Set(names)].sort();
  console.log('types matching Album/Track/Service/Broker:', uniq.length);
  for (const n of uniq) console.log(' ', n);
  roon.close();
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
