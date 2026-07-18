/**
 * Phase B codegen: read catalog.authoritative.json and emit src/generated/api.ts
 * — one typed class per service, one method per catalog RPC method, with args
 * built automatically from each param's `kind`. Run:
 *   npx ts-node tools/gen_client.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/catalog/catalog.authoritative.json'), 'utf8'));

const RESERVED = new Set(['default', 'function', 'new', 'delete', 'in', 'class', 'var', 'let', 'const', 'this', 'return']);
const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const sanitize = (n: string, i: number) => {
  let s = (n || `arg${i}`).replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  if (RESERVED.has(s)) s = s + '_';
  return s;
};
const isAccessor = (n: string) => /^(get_|set_|add_|remove_)/.test(n);

// --- refList audit + fix (the follow-up flagged in PR #2) ---------------------
//
// The serializer's `Arg.refList` (integer(count) + bare oids, NO length prefix)
// was the generated encoding for every collection param, and it is never
// correct — broker collections are uniformly length-prefixed and it stalls the
// Core. The reflist emission is now FIXED (argExpr: a length-prefixed
// Arg.collection of bare refs, the confirmed session-oid encoding). This block
// records the EVIDENCE per site — a provenance docblock on each affected method
// plus the full table in docs/reflist-audit.md. The two capture rounds and the
// resulting model live in the RefListFamily block below.
//
// `linkStructFor` is still useful: a `<X>Link` value struct is the shape of the
// STABLE-ID element form (the alternate to a bare ref), so the audit table
// reports, per site, whether the catalog even defines that form.
const LINK_STRUCTS = new Set(
  Object.keys(catalog.structs).filter((k: string) => k.endsWith('Link')),
);
function refListElementType(ptype: string): string {
  const m = /^System\.Collections\.Generic\.I(?:Enumerable|List)<(.+)>$/.exec(ptype);
  return m ? m[1] : ptype;
}
function linkStructFor(elemType: string): string | null {
  const base = elemType.replace(/^Sooloos\.Broker\.Api\./, '').replace(/Base$/, '');
  const candidate = `Sooloos.Broker.Api.${base}Link`;
  return LINK_STRUCTS.has(candidate) ? candidate : null;
}
interface RefListSite {
  service: string;
  method: string;
  param: string;
  elemType: string;
  link: string | null;
  family: RefListFamily;
}
const refListSites: RefListSite[] = [];

// Two capture rounds (2026-07-17, roonctl tools/re/fixtures/reflist) collapsed
// the audit's guesses. The generated Arg.refList (count + refs, NO length
// prefix) is never right; the correct framing is UNIFORMLY a length-prefixed
// Arg.collection. Element form is the CALLER's choice of identity, not a
// property of the method: bare session oids on the browse-driven path (the
// common case — confirmed across 8 methods spanning Transport action, Library
// curation, AND no-Link session objects), or inline <X>Link structs with stable
// ids only when identifying without a live session oid (FavoriteOrBan by
// AlbumId, PR #2). So there is no per-method family to predict — only evidence
// tiers: 'captured' (byte-for-byte from the official client), 'probed' (the
// Core accepted our encoding live — read methods, 2026-07-18), and 'presumed'
// (same uniform framing, untested).
type RefListFamily = 'captured' | 'probed' | 'presumed';
// Read methods confirmed by LIVE PROBE (2026-07-18, roonctl
// tools/re/probe-reflist-encodings.mjs): the Core accepted our length-prefixed
// collection (both bare-ref and inline-Link forms), no stall/reject. Weaker
// than a byte capture (it proves the Core accepts our encoding, not which form
// Roon itself sends) but sufficient to confirm emitting it is safe. Method-level
// (all these are Library single-collection reads).
const PROBED = new Set([
  'GetAlbumLites', 'GetPersistentAlbumIds', 'GetAlternateAlbumVersions', 'GetTrackExportInfoForAlbums',
  'GetTrackLites', 'GetPersistentTrackIds', 'GetExtendedTrackInfo', 'GetTrackExportInfoForTracks',
  'GetPerformerLites', 'GetPersistentPerformerIds', 'GetTrackExportInfoForPerformers',
  'GetWorkLites', 'GetPersistentWorkIds', 'GetTrackExportInfoForWorks',
]);
// The exact Service::Method::param sites observed on the wire (bare-ref
// collection). Param-level so we don't over-claim untriggered overloads — e.g.
// only FavoriteOrBan's `track` collection was hearted this session; its
// album/performer/work/folders collection overloads were not (its ALBUM form
// was captured separately in PR #2, but as the inline-struct variant, so it is
// left 'presumed' here).
const CAPTURED = new Set([
  'Transport::PlayTracks::tracks',
  'Transport::PlayWorks::works',
  'Transport::PlayPlaylistItems::items',
  'Transport::LinkEndpoints::endpoints',
  'Transport::UnlinkEndpoints::endpoints',
  'Queue::MoveItems::items',
  'Queue::RemoveItems::items',
  'Library::FavoriteOrBan::track',
]);
function refListFamily(service: string, method: string, param: string): RefListFamily {
  if (CAPTURED.has(`${service}::${method}::${param}`)) return 'captured';
  if (service === 'Library' && PROBED.has(method)) return 'probed';
  return 'presumed';
}

// kind -> TS param type
function tsType(kind: string): string {
  const base = kind.replace(/\?$/, '');
  const nul = kind.endsWith('?') ? ' | null' : '';
  switch (base) {
    case 'sooid': return 'Uint8Array' + nul;
    case 'prim:int': case 'prim:char': case 'enum': case 'prim:double': case 'prim:float': return 'number' + nul;
    case 'prim:long': return '(bigint | number)' + nul;
    case 'prim:bool': return 'boolean' + nul;
    case 'prim:string': return 'string | null';
    case 'ref': return 'bigint';
    case 'reflist': return '(bigint | number)[]';
    case 'bytes': return 'Uint8Array | null';
    case 'struct': return 'Record<string, unknown>';
    case 'primlist': return 'Buffer'; // pre-serialized (rare); caller supplies bytes
    default: return 'unknown';
  }
}

// kind -> expression producing a Buffer part, given the JS arg var `v` and the
// param's FQ type (for struct typeName).
function argExpr(kind: string, v: string, ptype: string): string {
  const base = kind.replace(/\?$/, '');
  switch (base) {
    case 'sooid': return `buildArgs([Arg.sooid(${v} ?? Buffer.alloc(0))])`;
    case 'prim:int': case 'prim:char': return `buildArgs([Arg.int(Number(${v} ?? 0))])`;
    case 'enum': return `buildArgs([Arg.enum_(Number(${v} ?? 0))])`;
    case 'prim:long': return `buildArgs([Arg.long((${v} ?? 0) as any)])`;
    case 'prim:bool': return `buildArgs([Arg.bool(Boolean(${v}))])`;
    case 'prim:double': case 'prim:float': return `buildArgs([Arg.double(Number(${v} ?? 0))])`;
    case 'prim:string': return `buildArgs([Arg.str(${v} ?? null)])`;
    case 'ref': return `buildArgs([Arg.ref(${v})])`;
    // FIXED (reflist-audit): broker IEnumerable<T> collections are uniformly a
    // LENGTH-PREFIXED collection of elements, never the bare Arg.refList
    // (count + refs) that stalls the Core. For the session-oid path — a caller
    // passing live object ids, which is what a client holds after a browse —
    // each element is a bare ref, so emit Arg.collection of Arg.ref buffers.
    // (Stable-id callers specialize with inline <X>Link structs; that path is
    // not expressible through this numeric-id signature — see docs/reflist-audit.md.)
    case 'reflist': return `buildArgs([Arg.collection((${v}).map((o) => buildArgs([Arg.ref(o)])))])`;
    case 'bytes': return `buildArgs([Arg.bytes(${v} ?? null)])`;
    case 'struct': return `buildStruct(this.c, ${JSON.stringify(ptype)}, (${v} ?? {}))`;
    case 'primlist': return `(${v})`; // raw bytes
    default: return `Buffer.alloc(0)`;
  }
}

// the FQ Sooloos type for a struct param (from the catalog param.type which is
// already the wire-FQ form, e.g. "Sooloos.Broker.Api.PlayParameters").
function structTypeName(ptype: string): string {
  return ptype.replace(/\?$/, '');
}

let out = `// AUTO-GENERATED by tools/gen_client.ts — do not edit.
/* eslint-disable */
import { RoonClient } from '../proto/client';
import { CallResult } from '../proto/remoting';
import { Arg, buildArgs, inlineStruct, serializeStructValue } from '../proto/serializer';

const STRUCTS: Record<string, { name: string; propType: number }[]> = ${JSON.stringify(
  Object.fromEntries(Object.entries(catalog.structs).map(([k, v]: any) => [k, v.members.map((m: any) => ({ name: m.name, propType: m.propType }))])),
)};

function buildStruct(c: RoonClient, typeName: string, fields: Record<string, unknown>): Buffer {
  const members = STRUCTS[typeName] || [];
  const typeId = c.remoting.defineType(typeName, members);
  const entries: { index: number; value: Buffer }[] = [];
  for (const [k, val] of Object.entries(fields)) {
    const idx = members.findIndex((m) => m.name === k);
    if (idx < 0) continue;
    entries.push({ index: idx + 1, value: serializeStructValue(members[idx].propType, val) });
  }
  return inlineStruct(typeId, entries);
}

/** Base for a generated service bound to an object id. */
class ServiceBase {
  constructor(protected c: RoonClient, protected oid: bigint) {}
}
`;

const factoryEntries: string[] = [];

for (const svc of catalog.services) {
  const cls = `${svc.name.replace(/[^A-Za-z0-9_]/g, '_')}Api`;
  const seen = new Map<string, number>();
  let body = '';
  for (const m of svc.methods) {
    if (isAccessor(m.name)) continue;
    let mname = camel(m.name.replace(/[^A-Za-z0-9_]/g, '_'));
    const n = (seen.get(mname) || 0) + 1;
    seen.set(mname, n);
    if (n > 1) mname = `${mname}_${n}`;

    const params = (m.params || []).filter((p: any) => p.kind !== 'callback');
    const tsParams = params
      .map((p: any, i: number) => `${sanitize(p.name, i)}: ${tsType(p.kind)}`)
      .join(', ');
    const parts = params.map((p: any, i: number) => `      ${argExpr(p.kind, sanitize(p.name, i), structTypeName(p.type))},`).join('\n');
    const sig = JSON.stringify(m.signature);
    const refListParams = params.filter((p: any) => String(p.kind).replace(/\?$/, '') === 'reflist');
    for (const p of refListParams) {
      const elemType = refListElementType(p.type);
      refListSites.push({ service: svc.name, method: m.name, param: p.name, elemType, link: linkStructFor(elemType), family: refListFamily(svc.name, m.name, p.name) });
    }
    if (refListParams.length > 0) {
      const notes = refListParams.map((p: any, i: number) => {
        const short = refListElementType(p.type).replace(/^Sooloos\.Broker\.Api\./, '');
        const arg = sanitize(p.name, i);
        const fam = refListFamily(svc.name, m.name, p.name);
        // The reflist emission is now the FIXED length-prefixed bare-ref
        // collection (see argExpr). These notes record the evidence tier for
        // \`${arg}\`, not a warning.
        if (fam === 'captured')
          return `   * reflist-audit: \`${arg}\` (${short}) — length-prefixed bare-ref collection,\n` +
            `   * CONFIRMED byte-for-byte against the official client (capture 2026-07-17).`;
        if (fam === 'probed')
          return `   * reflist-audit: \`${arg}\` (${short}) — length-prefixed bare-ref collection,\n` +
            `   * CONFIRMED live: the Core accepts it (probe 2026-07-18). See docs/reflist-audit.md.`;
        return `   * reflist-audit: \`${arg}\` (${short}) — length-prefixed bare-ref collection\n` +
          `   * (the uniform model; this exact site is not individually captured — capture-diff\n` +
          `   * if it misbehaves, and see docs/reflist-audit.md for the stable-id path).`;
      });
      body += `  /**\n${notes.join('\n')}\n   */\n`;
    }
    if (m.expectsResponse) {
      body += `  async ${mname}(${tsParams}): Promise<CallResult> {
    const parts: Buffer[] = [
${parts}
    ];
    return this.c.remoting.callMethod(this.oid, ${sig}, Buffer.concat(parts));
  }
`;
    } else {
      body += `  ${mname}(${tsParams}): void {
    const parts: Buffer[] = [
${parts}
    ];
    this.c.remoting.callMethodNoReply(this.oid, ${sig}, Buffer.concat(parts));
  }
`;
    }
  }
  out += `\nexport class ${cls} extends ServiceBase {\n${body}}\n`;
  factoryEntries.push(`  get ${camel(svc.name.replace(/[^A-Za-z0-9_]/g, '_'))}() { return new ${cls}(c, c.serviceOid(${JSON.stringify(svc.name)})); }`);
}

// A factory that lazily binds singleton services to their resolved object ids.
out += `\n/** Bind generated services to a connected client. Service singletons resolve\n * their object id via the object graph; entity classes can be constructed with\n * an explicit oid: new ZoneApi(client, zoneOid). */\nexport function makeApi(c: RoonClient) {\n  return {\n${factoryEntries.join(',\n')}\n  };\n}\n`;

const dir = path.join(root, 'src/generated');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'api.ts'), out);
const methodCount = catalog.services.reduce((a: number, s: any) => a + s.methods.filter((m: any) => !isAccessor(m.name)).length, 0);
console.log(`generated src/generated/api.ts: ${catalog.services.length} services, ${methodCount} methods`);

// --- docs/reflist-audit.md — the full classification table -------------------
const short = (t: string) => t.replace(/^Sooloos\.Broker\.Api\./, '');
const byFam = (f: RefListFamily) => refListSites.filter((s) => s.family === f);
const row = (s: RefListSite) =>
  `| \`${s.service}\` | \`${s.method}\` | \`${s.param}\` | ${short(s.elemType)} | ${s.link ? short(s.link) : '—'} |`;
const capturedS = byFam('captured');
const probedS = byFam('probed');
const presumedS = byFam('presumed');
const audit = `# refList call-site audit + fix

*Generated by \`tools/gen_client.ts\` — regenerate, don't edit. The follow-up
flagged in [PR #2](https://github.com/arthursoares/roon-api-reverse-engineering/pull/2),
resolved by two live capture rounds (2026-07-17) and a live-probe sweep (2026-07-18).*

**Fixed:** the generator no longer emits \`Arg.refList\` for collection params.
It now emits a length-prefixed \`Arg.collection\` of bare refs — the confirmed
session-oid encoding. This table records the evidence per site.

\`Arg.refList\` (integer(count) + bare object refs, **no length prefix**) was the
old generated encoding for every collection param. **It is never correct.**
Capturing the official client (${capturedS.length} methods, spanning Transport
action, Library curation, and Queue session-objects) showed one universal
framing and two element forms:

| Shape | Framing | Elements | |
|---|---|---|---|
| \`Arg.refList\` (generated) | \`count + refs\` | bare refs | stalls the Core |
| collection of **bare refs** | \`flexInt(bodyLen) + count + refs\` | bare flexLong session oids | the common (browse-driven) path |
| collection of **inline structs** | \`flexInt(bodyLen) + count + structs\` | inline \`<X>Link\`, **stable** id | the stable-id path only |

The element form is the **caller's choice of identity**, not a property of the
method: \`FavoriteOrBan\` was captured sending bare session oids (hearting
browsed tracks) AND, in PR #2, inline \`AlbumLink\` structs (favoriting by
stable \`AlbumId\`). So the earlier Link/no-Link and action/curation groupings
**do not predict the encoding** — for a caller holding session oids (what a
client has after a search/browse), the uniform fix for every site below is
\`Arg.collection\` of bare refs.

## Confirmed by capture — ${capturedS.length} sites

Byte-for-byte validated 2026-07-17 (roonctl \`tools/re/fixtures/reflist\`,
\`src/broker/reflistEncoding.test.ts\`): length-prefixed \`Arg.collection\` of
bare refs.

| Service | Method | Param | Element type | Link struct |
|---|---|---|---|---|
${capturedS.map(row).join('\n')}

## Confirmed by live probe — ${probedS.length} sites

Live-effect validated 2026-07-18 (roonctl \`tools/re/probe-reflist-encodings.mjs\`):
the Core accepted a length-prefixed \`Arg.collection\` (both bare-ref and
inline-Link forms), no stall or reject, across all four element types. Weaker
than a byte capture — it confirms the Core accepts our encoding, not which form
Roon itself emits — but sufficient to confirm emitting it is safe.

| Service | Method | Param | Element type | Link struct |
|---|---|---|---|---|
${probedS.map(row).join('\n')}

## Presumed — ${presumedS.length} sites

Not individually captured. Same universal framing applies; on the session-oid
path use \`Arg.collection\` of bare refs (identical to the confirmed set), on the
stable-id path use inline \`<X>Link\` structs. Capture-diff before trusting any
specific one. (\`Link struct\` column = whether the catalog defines an
\`<X>Link\` for the stable-id form.)

| Service | Method | Param | Element type | Link struct |
|---|---|---|---|---|
${presumedS.map(row).join('\n')}
`;
const docsDir = path.join(root, 'docs');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, 'reflist-audit.md'), audit);
console.log(
  `generated docs/reflist-audit.md: ${refListSites.length} refList sites ` +
    `(${capturedS.length} captured, ${probedS.length} probed, ${presumedS.length} presumed)`,
);
