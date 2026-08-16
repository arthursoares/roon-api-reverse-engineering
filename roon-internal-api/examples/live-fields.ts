/**
 * READ-ONLY live field-inspection probe (Phase 1).
 *
 * Connects to the live Core's internal protocol (9332), loads the object graph,
 * and inventories the FIELD NAMES present on AlbumLite / Album / TrackLite /
 * Track objects — specifically to decide whether `service` / `added` /
 * `IsStreamable` are populated, i.e. whether a "newly-added streaming album"
 * detector can harvest from the live graph.
 *
 * No mutations. Field KEYS are the fully-qualified DEFTYPE member names; we
 * report the distinct member suffixes per type plus which of the flagged
 * streaming/date/service fields are present (and their value shapes).
 */
import { RoonClient, RoonClientOptions } from '../src/proto/client';

// Core: Nova (novababilonia.me / 192.168.178.30). serverBrokerId verified from a
// live handshake capture (2026-08-15): wire GUID of Core 17025f46-...
const HOST = process.env.ROON_HOST || '192.168.178.30';
const SERVER_BROKER_ID = Buffer.from(process.env.ROON_BROKER || '465f021738d44b46bbe84c20a05a313b', 'hex');

// Field keys are fully-qualified ("string Sooloos.Broker.Api.AlbumLite::Title").
// We reduce each to the member suffix (the `::Name` part) for a per-type set.
function memberSuffix(key: string): string {
  const i = key.indexOf('::');
  return i < 0 ? key : key.slice(i + 2);
}

/** The value "shape" of a field, for the flagged streaming/date/service fields. */
function shape(v: unknown): string {
  if (Buffer.isBuffer(v)) return 'sooid/bytes';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    if ('$ref' in (v as object)) return `ref(${(v as any).$ref})`;
    if ('$type' in (v as object)) return `${(v as any).$type}`;
    return 'object';
  }
  if (typeof v === 'bigint') return `${typeof v}:${v.toString()}`;
  return `${typeof v}:${JSON.stringify(v)}`;
}

// Flagged fields of interest for the qobuz/streaming auto-download goal.
const FLAGGED = [
  'Service', 'ServiceName', 'Added', 'DateAdded', 'ImportDate',
  'IsStreamable', 'IsQobuz', 'IsTidal', 'IsDownloadable', 'IsDownloaded',
  'IsOffline', 'IsStreamableByService', 'AvailableServices',
];

function reportType(roon: RoonClient, typeName: string): void {
  const objs = roon.graph.findByType(typeName);
  if (!objs.length) {
    console.log(`\n== ${typeName}: 0 objects loaded ==`);
    return;
  }
  // Distinct member-suffix sets across all objects of this type.
  const suffixSet = new Set<string>();
  const flaggedPresent = new Map<string, string>(); // flagged name -> value shape of first occurrence
  for (const o of objs) {
    for (const k of Object.keys(o.fields)) suffixSet.add(memberSuffix(k));
    for (const f of FLAGGED) {
      const hit = Object.keys(o.fields).find((k) => memberSuffix(k) === f);
      if (hit && !flaggedPresent.has(f)) flaggedPresent.set(f, shape(o.fields[hit]));
    }
  }
  console.log(`\n== ${typeName}: ${objs.length} objects, ${suffixSet.size} distinct field names ==`);
  console.log('   FIELD-NAME INVENTORY:');
  const sorted = [...suffixSet].sort((a, b) => a.localeCompare(b));
  for (const s of sorted) console.log(`     ${s}`);
  console.log('   FLAGGED (service/added/streamable/download):');
  if (flaggedPresent.size === 0) {
    console.log('     (none present)');
  } else {
    for (const [f, sh] of [...flaggedPresent].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`     ${f} -> ${sh}`);
    }
  }
}

function reportSchema(roon: RoonClient, shortName: string): void {
  const defs = [...roon.graph.types.values()].filter((d) => d.name.endsWith(shortName));
  if (!defs.length) {
    console.log(`\n== SCHEMA ${shortName}: no DEFTYPE ==`);
    return;
  }
  for (const d of defs) {
    console.log(`\n== SCHEMA ${d.name} (typeId=${d.id}, ${d.members.length} members) ==`);
    const flagged = new Set<string>();
    for (const m of d.members) {
      const f = m.name.endsWith('::') ? m.name.slice(m.name.lastIndexOf('::') + 2) : m.name;
      if (FLAGGED.includes(f)) flagged.add(f);
    }
    for (const m of d.members) console.log(`   ${m.name} (propType ${m.propType})`);
    if (flagged.size) console.log(`   FLAGGED PRESENT: ${[...flagged].join(', ')}`);
    else console.log('   FLAGGED: (none)');
  }
}

async function main(): Promise<void> {
  const opts: RoonClientOptions = { host: HOST, serverBrokerId: SERVER_BROKER_ID };
  const roon = new RoonClient(opts);
  await roon.connect();
  console.log(`connected to ${HOST}:9332`);
  console.log(`types=${roon.graph.types.size} objects=${roon.graph.objects.size}`);

  for (const t of ['AlbumLite', 'Album', 'TrackLite', 'Track']) reportType(roon, t);
  for (const t of ['AlbumLite', 'Album', 'TrackLite', 'Track']) reportSchema(roon, t);

  // Sample: show the full field set (name -> shape) for one AlbumLite + one TrackLite.
  const al = roon.graph.findByType('AlbumLite')[0];
  const tl = roon.graph.findByType('TrackLite')[0];
  if (al) {
    console.log(`\nSample AlbumLite oid=${al.oid}:`);
    for (const [k, v] of Object.entries(al.fields)) console.log(`  ${k} = ${shape(v)}`);
  }
  if (tl) {
    console.log(`\nSample TrackLite oid=${tl.oid}:`);
    for (const [k, v] of Object.entries(tl.fields)) console.log(`  ${k} = ${shape(v)}`);
  }

  roon.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
