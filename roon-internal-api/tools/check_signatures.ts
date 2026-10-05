/**
 * Signature-drift check: do the wire names the shipping SDK sends still exist in
 * a given Roon.Broker.Api.dll?
 *
 * The Core silently ignores a DEFMETHOD signature or DEFTYPE member name it does
 * not know, so a Roon update that moves one makes a call quietly do nothing.
 * This checker compares, offline and deterministically:
 *
 *   SDK wire names   every method signature, struct member and struct type name
 *                    the SDK can emit, extracted from the TypeScript AST of src/
 *                    (generated + handwritten code, resolved const/template
 *                    literals, formatMethodSignature/RoonClient.call call sites,
 *                    structArg short member names)
 *   DLL dump         a declared-only metadata dump (tools/dump_broker_api.py)
 *   catalog          src/catalog/catalog.authoritative.json, the provenance of
 *                    the generated code: SDK vs catalog must agree, and the
 *                    catalog-vs-dump delta is reported
 *
 * Normalization is explicit and narrow: only the evidenced metadata namespace
 * alias Roon.Broker.Api. -> Sooloos.Broker.Api. (#15), applied to the dump side
 * and reported with a count. Wire names are compared verbatim. Inheritance and
 * generic substitution are modeled, never assumed: an interface method binds
 * under a derived interface only through its declared interface list, with the
 * base's generic parameters substituted; a same-named method on an unrelated
 * type is a hint, not a match.
 *
 *   npx ts-node tools/check_signatures.ts --dump PATH   SDK vs DLL dump (+ catalog)
 *   npx ts-node tools/check_signatures.ts --catalog-only SDK vs committed catalog
 *   npx ts-node tools/check_signatures.ts --self-test    fixtures + SDK inventory
 *
 * Exit codes: 0 clean, 1 drift or catalog mismatch, 2 input/usage error.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { CatalogParam, formatMethodSignature } from '../src/catalog/signature';

export const WIRE_NS = 'Sooloos.Broker.Api.';
export const METADATA_NS = 'Roon.Broker.Api.';
export const DUMP_FORMAT = 'roon-broker-api-dump';
const PKG_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CATALOG = path.join(PKG_ROOT, 'src/catalog/catalog.authoritative.json');
const FIXTURES = path.join(__dirname, 'fixtures/signature-drift');
const NS_HINT = `the wire spells the broker namespace ${WIRE_NS}*; ${METADATA_NS}* is a metadata-only rename (Roon 2.71, see #15) — do not send it`;

/** Unreadable, invalid or foreign input (exit 2). */
export class InputError extends Error {}

// ---------------------------------------------------------------------------
// Type-name helpers
// ---------------------------------------------------------------------------

/** Split on top-level commas (generic-argument lists, parameter lists). */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `Ns.Name<A, B>` -> key `Ns.Name\`2` + args; `Ns.Name\`1` and `Ns.Name` pass through. */
export function parseTypeRef(s: string): { key: string; args: string[] } {
  const t = s.trim();
  const lt = t.indexOf('<');
  if (lt < 0 || !t.endsWith('>')) return { key: t, args: [] };
  const args = splitTop(t.slice(lt + 1, -1));
  return { key: `${t.slice(0, lt)}\`${args.length}`, args };
}

/** Replace generic parameter names (whole, unqualified identifiers) in one pass. */
export function substitute(type: string, subst: Readonly<Record<string, string>>): string {
  if (!Object.keys(subst).length) return type;
  return type.replace(/(?<![\w.`])([A-Za-z_]\w*)(?![\w.`])/g, (m) => (Object.hasOwn(subst, m) ? subst[m] : m));
}

const shortNs = (s: string) => s.split(WIRE_NS).join('').split(METADATA_NS).join('');

export function parseMethodSig(sig: string): { decl: string; name: string; params: string } | undefined {
  const m = /^(.+?)::([A-Za-z_][\w]*)\((.*)\)$/.exec(sig);
  if (!m || m[1].includes('(')) return undefined;
  return { decl: m[1], name: m[2], params: m[3] };
}

export function parseMember(member: string): { type: string; decl: string; name: string } | undefined {
  const idx = member.lastIndexOf('::');
  if (idx < 0) return undefined;
  const name = member.slice(idx + 2);
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  const left = member.slice(0, idx);
  let depth = 0;
  for (let i = left.length - 1; i >= 0; i--) {
    const ch = left[i];
    if (ch === '>') depth++;
    else if (ch === '<') depth--;
    else if (ch === ' ' && depth === 0) {
      const type = left.slice(0, i).trim();
      return type ? { type, decl: left.slice(i + 1), name } : undefined;
    }
  }
  return undefined;
}

const BROKER_PREFIX = /^(?:Sooloos|Roon)\.Broker\.Api\./;
const TYPE_RE = /^(?:Sooloos|Roon)\.Broker\.Api\.[A-Za-z_][\w`+.]*(?:<.+>)?$/;

export type WireKind = 'method' | 'member' | 'type' | 'shortMember';

/** Classify a resolved string as a wire name, or undefined. */
export function classify(text: string): { kind: WireKind; name: string } | undefined {
  const sig = parseMethodSig(text);
  if (sig && BROKER_PREFIX.test(sig.decl)) return { kind: 'method', name: text };
  const member = parseMember(text);
  if (member && BROKER_PREFIX.test(member.decl) && !member.type.includes('::')) return { kind: 'member', name: text };
  // Spaces only inside generic arguments ("X<A, B>").
  if (TYPE_RE.test(text) && !text.replace(/<.*>$/, '').includes(' ')) return { kind: 'type', name: text };
  return undefined;
}

// ---------------------------------------------------------------------------
// SDK inventory (TypeScript AST)
// ---------------------------------------------------------------------------

export interface Site { file: string; line: number }
export interface WireName { kind: WireKind; name: string; owner?: string; origins: string[]; sites: Site[] }
export interface Unresolved { site: Site; expr: string; reason: string }
export interface Inventory { names: WireName[]; unresolved: Unresolved[]; files: string[] }

const MAX_EXPANSION = 64;

class FileEval {
  private consts = new Map<string, ts.Expression | null>();

  constructor(readonly sf: ts.SourceFile) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Const) {
        for (const d of n.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          // Same name declared twice in one file: ambiguous, never guess.
          this.consts.set(d.name.text, this.consts.has(d.name.text) ? null : d.initializer);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  /** All string values an expression can take, or undefined if runtime-only. */
  strings(e: ts.Expression, depth = 0): string[] | undefined {
    if (depth > 8) return undefined;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return this.strings(e.expression, depth + 1);
    if (ts.isTemplateExpression(e)) {
      let acc: string[] = [e.head.text];
      for (const span of e.templateSpans) {
        const vals = this.strings(span.expression, depth + 1);
        if (!vals) return undefined;
        const next = cartesian(acc, vals.map((v) => v + span.literal.text));
        if (!next) return undefined;
        acc = next;
      }
      return acc;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.strings(e.left, depth + 1);
      const r = l && this.strings(e.right, depth + 1);
      return l && r ? cartesian(l, r) : undefined;
    }
    if (ts.isIdentifier(e)) {
      const init = this.consts.get(e.text);
      if (init) return this.strings(init, depth + 1);
      return literalUnionOfParameter(e);
    }
    return undefined;
  }

  site(n: ts.Node): Site {
    return { file: path.relative(PKG_ROOT, this.sf.fileName).split(path.sep).join('/'), line: this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf)).line + 1 };
  }
}

/** Too many combinations is treated as runtime-only (reported), never as "no names". */
function cartesian(a: string[], b: string[]): string[] | undefined {
  if (a.length * b.length > MAX_EXPANSION) return undefined;
  return a.flatMap((x) => b.map((y) => x + y));
}

/** A parameter typed as a string-literal union ('Pause' | 'Play' | ...) expands to its members. */
function literalUnionOfParameter(id: ts.Identifier): string[] | undefined {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (!ts.isFunctionLike(n)) continue;
    const param = n.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
    if (!param) continue;
    const t = param.type;
    const lits = !t ? undefined : ts.isUnionTypeNode(t) ? t.types : [t];
    if (!lits) return undefined;
    const out: string[] = [];
    for (const lt of lits) {
      if (ts.isLiteralTypeNode(lt) && ts.isStringLiteral(lt.literal)) out.push(lt.literal.text);
      else return undefined;
    }
    return out;
  }
  return undefined;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
}

/** `[{ type: 'Sooid', name: 'p' }, ...]` -> CatalogParam[], or undefined if runtime. */
function catalogParams(fe: FileEval, e: ts.Expression): CatalogParam[][] | undefined {
  if (!ts.isArrayLiteralExpression(e)) return undefined;
  let acc: CatalogParam[][] = [[]];
  for (const el of e.elements) {
    if (!ts.isObjectLiteralExpression(el)) return undefined;
    const prop = (key: string) => el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key);
    const typeProp = prop('type');
    const types = typeProp && fe.strings(typeProp.initializer);
    if (!types) return undefined;
    const nameProp = prop('name');
    const name = (nameProp && fe.strings(nameProp.initializer)?.[0]) ?? '';
    acc = acc.flatMap((prefix) => types.map((type) => [...prefix, { type, name }]));
    if (acc.length > MAX_EXPANSION) return undefined;
  }
  return acc;
}

const exprText = (fe: FileEval, n: ts.Node) => n.getText(fe.sf).replace(/\s+/g, ' ').slice(0, 120);

/** Every .ts file under src/ that ships (tests excluded). */
export function sdkFiles(root = PKG_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

export function extractInventory(files: string[] = sdkFiles()): Inventory {
  const names = new Map<string, WireName>();
  const unresolved: Unresolved[] = [];
  const add = (kind: WireKind, name: string, origin: string, site: Site, owner?: string): void => {
    const key = `${kind}\u0000${owner ?? ''}\u0000${name}`;
    const existing = names.get(key);
    if (existing) {
      existing.sites.push(site);
      if (!existing.origins.includes(origin)) existing.origins = [...existing.origins, origin].sort();
    } else names.set(key, { kind, name, owner, origins: [origin], sites: [site] });
  };

  for (const file of files) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const fe = new FileEval(sf);
    const generated = /[\\/]src[\\/]generated[\\/]/.test(file);
    const literalOrigin = generated ? 'generated' : 'handwritten';

    const methodCall = (call: ts.CallExpression, svcArg: ts.Expression, methodArg: ts.Expression, paramsArg: ts.Expression, origin: string): void => {
      const services = fe.strings(svcArg);
      const methods = fe.strings(methodArg);
      const paramSets = catalogParams(fe, paramsArg);
      const missing = [!services && 'service', !methods && 'method', !paramSets && 'params'].filter(Boolean);
      if (missing.length) {
        unresolved.push({ site: fe.site(call), expr: exprText(fe, call), reason: `runtime-only ${missing.join(', ')}` });
        return;
      }
      for (const s of services!) for (const m of methods!) for (const ps of paramSets!) {
        add('method', formatMethodSignature(s, m, ps), origin, fe.site(call));
      }
    };

    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const c = classify(n.text);
        if (c) add(c.kind, c.name, literalOrigin, fe.site(n));
      } else if (ts.isTemplateExpression(n)) {
        const vals = fe.strings(n);
        if (vals) {
          for (const v of vals) {
            const c = classify(v);
            if (c) add(c.kind, c.name, `${literalOrigin} template`, fe.site(n));
          }
        } else if (/Broker\.Api\./.test(n.head.text + n.templateSpans.map((s) => s.literal.text).join('')) || n.templateSpans.some((s) => (fe.strings(s.expression) ?? []).some((v) => BROKER_PREFIX.test(v)))) {
          // Only templates that spell the broker namespace are wire names;
          // `::${name}` graph lookups and error messages are not.
          unresolved.push({ site: fe.site(n), expr: exprText(fe, n), reason: 'template with runtime-only parts' });
        }
      } else if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        const a = n.arguments;
        if (name === 'formatMethodSignature' && a.length === 3) {
          methodCall(n, a[0], a[1], a[2], 'formatMethodSignature');
        } else if (name === 'call' && ts.isPropertyAccessExpression(n.expression) && a.length >= 4 && (fe.strings(a[0]) || ts.isArrayLiteralExpression(a[2]))) {
          methodCall(n, a[0], a[1], a[2], 'RoonClient.call');
        } else if (name === 'structArg' && (a.length === 2 || a.length === 3)) {
          const [typeArg, fieldsArg] = a.length === 2 ? [a[0], a[1]] : [a[1], a[2]];
          const types = fe.strings(typeArg);
          if (!types || !ts.isArrayLiteralExpression(fieldsArg)) {
            unresolved.push({ site: fe.site(n), expr: exprText(fe, n), reason: `runtime-only ${!types ? 'struct type' : 'field list'}` });
          } else {
            for (const t of types) add('type', t, 'structArg', fe.site(typeArg));
            for (const el of fieldsArg.elements) {
              const nameProp = ts.isObjectLiteralExpression(el)
                ? el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name')
                : undefined;
              const vals = nameProp && fe.strings(nameProp.initializer);
              if (!vals) {
                unresolved.push({ site: fe.site(el), expr: exprText(fe, el), reason: 'runtime-only struct field name' });
                continue;
              }
              for (const v of vals) if (!v.includes('::')) for (const t of types) add('shortMember', v, 'structArg', fe.site(el), t);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const sorted = [...names.values()].sort((x, y) => x.kind.localeCompare(y.kind) || (x.owner ?? '').localeCompare(y.owner ?? '') || x.name.localeCompare(y.name));
  unresolved.sort((x, y) => x.site.file.localeCompare(y.site.file) || x.site.line - y.site.line);
  return { names: sorted, unresolved, files: files.map((f) => path.relative(PKG_ROOT, f).split(path.sep).join('/')) };
}

// ---------------------------------------------------------------------------
// DLL dump model
// ---------------------------------------------------------------------------

interface DumpMethod { name: string; params: string[]; returns?: string }
interface DumpProperty { name: string; type: string }
interface DumpIndexer { name: string; type: string; params: string[] }
export interface DumpType {
  name: string; kind: string; genericParams: string[]; extends: string | null; interfaces: string[];
  attributes: string[]; methods: DumpMethod[]; properties: DumpProperty[]; indexers: DumpIndexer[];
}
export interface Dump { format: string; formatVersion: number; assembly?: Record<string, unknown>; types: DumpType[] }

export function parseDump(text: string | Buffer, label: string): Dump {
  const buf = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  if (buf.subarray(0, 2).toString('latin1') === 'MZ') {
    throw new InputError(`${label}: this is a PE/DLL, not a dump — run tools/dump_broker_api.py --dll <dll> --out <dump.json> first`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new InputError(`${label}: not JSON (${(err as Error).message})`);
  }
  const d = raw as Partial<Dump>;
  if (!d || typeof d !== 'object' || d.format !== DUMP_FORMAT) {
    throw new InputError(`${label}: not a ${DUMP_FORMAT} file (format=${JSON.stringify((d as { format?: unknown })?.format)})`);
  }
  if (d.formatVersion !== 1) throw new InputError(`${label}: unsupported formatVersion ${JSON.stringify(d.formatVersion)}`);
  if (!Array.isArray(d.types)) throw new InputError(`${label}: missing types[]`);
  const types: DumpType[] = d.types.map((t, i) => {
    const bad = (what: string) => new InputError(`${label}: types[${i}] ${what}`);
    if (!t || typeof t.name !== 'string' || !t.name) throw bad('has no name');
    const strArr = (v: unknown, what: string) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${what} must be a string array`);
      return v as string[];
    };
    const objArr = <T>(v: unknown, what: string, ok: (x: any) => boolean): T[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every(ok)) throw bad(`${what} entries are malformed`);
      return v as T[];
    };
    const sig = (x: any) => x && typeof x.name === 'string' && Array.isArray(x.params) && x.params.every((p: unknown) => typeof p === 'string');
    return {
      name: t.name,
      kind: typeof t.kind === 'string' ? t.kind : 'class',
      genericParams: strArr(t.genericParams, 'genericParams'),
      extends: typeof t.extends === 'string' && t.extends ? t.extends : null,
      interfaces: strArr(t.interfaces, 'interfaces'),
      attributes: strArr(t.attributes, 'attributes'),
      methods: objArr<DumpMethod>(t.methods, 'methods', sig),
      properties: objArr<DumpProperty>(t.properties, 'properties', (x) => x && typeof x.name === 'string' && typeof x.type === 'string'),
      indexers: objArr<DumpIndexer>(t.indexers, 'indexers', (x) => sig(x) && typeof x.type === 'string'),
    };
  });
  if (!types.some((t) => BROKER_PREFIX.test(t.name))) {
    throw new InputError(`${label}: foreign input — declares no ${WIRE_NS}* or ${METADATA_NS}* types (wrong assembly?)`);
  }
  return { format: d.format, formatVersion: d.formatVersion, assembly: d.assembly, types };
}

export function loadDump(file: string): Dump {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    throw new InputError(`${file}: unreadable (${(err as Error).message})`);
  }
  return parseDump(buf, file);
}

/** Metadata-side alias: Roon.Broker.Api. -> Sooloos.Broker.Api. Counts every rewritten name. */
function normalizeDump(dump: Dump): { types: DumpType[]; aliased: number } {
  let aliased = 0;
  const n = (s: string) => {
    if (!s.includes(METADATA_NS)) return s;
    aliased++;
    return s.split(METADATA_NS).join(WIRE_NS);
  };
  const types = dump.types.map((t) => ({
    ...t,
    name: n(t.name),
    extends: t.extends === null ? null : n(t.extends),
    interfaces: t.interfaces.map(n),
    // Return types never reach the wire signature; they are left as declared.
    methods: t.methods.map((m) => ({ ...m, params: m.params.map(n) })),
    properties: t.properties.map((p) => ({ ...p, type: n(p.type) })),
    indexers: t.indexers.map((p) => ({ ...p, type: n(p.type), params: p.params.map(n) })),
  }));
  return { types, aliased };
}

/** BCL interface contracts the dump cannot contain (they live in the runtime). */
export const BCL_CONTRACTS: Readonly<Record<string, { params: string[]; methods: string[] }>> = {
  'System.IDisposable': { params: [], methods: ['Dispose()'] },
  'System.Collections.IEnumerable': { params: [], methods: ['GetEnumerator()'] },
  'System.Collections.ICollection': { params: [], methods: ['CopyTo(System.Array, int)', 'get_Count()', 'get_SyncRoot()', 'get_IsSynchronized()'] },
  'System.Collections.IDictionary': {
    params: [],
    methods: ['get_Item(object)', 'set_Item(object, object)', 'get_Keys()', 'get_Values()', 'Contains(object)', 'Add(object, object)', 'Clear()', 'get_IsReadOnly()', 'get_IsFixedSize()', 'GetEnumerator()', 'Remove(object)'],
  },
  'System.Collections.Generic.IEnumerable`1': { params: ['T'], methods: ['GetEnumerator()'] },
  'System.Collections.Generic.ICollection`1': { params: ['T'], methods: ['get_Count()', 'get_IsReadOnly()', 'Add(T)', 'Clear()', 'Contains(T)', 'CopyTo(T[], int)', 'Remove(T)'] },
  'System.Collections.Generic.IList`1': { params: ['T'], methods: ['get_Item(int)', 'set_Item(int, T)', 'IndexOf(T)', 'Insert(int, T)', 'RemoveAt(int)'] },
  'System.Collections.Generic.IReadOnlyCollection`1': { params: ['T'], methods: ['get_Count()'] },
  'System.Collections.Generic.IReadOnlyList`1': { params: ['T'], methods: ['get_Item(int)'] },
  'System.Collections.Generic.IDictionary`2': {
    params: ['TKey', 'TValue'],
    methods: ['get_Item(TKey)', 'set_Item(TKey, TValue)', 'get_Keys()', 'get_Values()', 'ContainsKey(TKey)', 'Add(TKey, TValue)', 'Remove(TKey)', 'TryGetValue(TKey, TValue&)'],
  },
};
const ROOT_BASES = new Set(['object', 'System.Object', 'System.ValueType', 'System.Enum', 'System.MulticastDelegate', 'System.Delegate', 'System.Attribute']);

export type Via = 'declared' | 'inherited' | 'bcl';
export interface Binding { via: Via; chain: string[]; substituted: boolean }
export interface Bound {
  methods: Map<string, Binding>;
  members: Map<string, Binding>;
  memberNames: Map<string, string[]>;
  indexers: string[];
  ancestors: Set<string>;
  bcl: Set<string>;
  external: Set<string>;
}

export class DumpModel {
  readonly types = new Map<string, DumpType>();
  readonly aliased: number;
  private cache = new Map<string, Bound | string>();
  /** `Name(params)` -> declaring type keys (unrelated-type hints only). */
  readonly declaredBy = new Map<string, string[]>();

  constructor(readonly dump: Dump) {
    const { types, aliased } = normalizeDump(dump);
    this.aliased = aliased;
    for (const t of types) {
      this.types.set(t.name, t);
      for (const m of t.methods) {
        const k = `${m.name}(${m.params.join(', ')})`;
        this.declaredBy.set(k, [...(this.declaredBy.get(k) ?? []), t.name]);
      }
    }
  }

  /** Resolve a wire declaring type (plain, open `X\`1`, or closed `X<A>`); string = why not. */
  bound(decl: string): Bound | string {
    const hit = this.cache.get(decl);
    if (hit) return hit;
    const { key, args } = parseTypeRef(decl);
    const t = this.types.get(key);
    let result: Bound | string;
    if (!t) result = `declaring type ${decl} is not in the DLL`;
    else if (args.length && args.length !== t.genericParams.length) result = `${key} takes ${t.genericParams.length} type argument(s), wire passes ${args.length}`;
    else {
      const subst = Object.fromEntries(args.map((a, i) => [t.genericParams[i], a]));
      const b: Bound = { methods: new Map(), members: new Map(), memberNames: new Map(), indexers: [], ancestors: new Set(), bcl: new Set(), external: new Set() };
      this.collect(key, subst, decl, [], b, new Set());
      result = b;
    }
    this.cache.set(decl, result);
    return result;
  }

  private collect(key: string, subst: Record<string, string>, display: string, chain: string[], b: Bound, seen: Set<string>): void {
    const visitKey = `${key}|${JSON.stringify(subst)}`;
    if (seen.has(visitKey)) return;
    seen.add(visitKey);
    const t = this.types.get(key)!;
    b.ancestors.add(key);
    const via: Via = chain.length ? 'inherited' : 'declared';
    for (const m of t.methods) {
      const params = m.params.map((p) => substitute(p, subst));
      const sig = `${display}::${m.name}(${params.join(', ')})`;
      bind(b.methods, sig, { via, chain, substituted: params.some((p, i) => p !== m.params[i]) });
    }
    for (const p of t.properties) {
      const type = substitute(p.type, subst);
      const member = `${type} ${display}::${p.name}`;
      bind(b.members, member, { via, chain, substituted: type !== p.type });
      b.memberNames.set(p.name, [...(b.memberNames.get(p.name) ?? []), member]);
    }
    for (const ix of t.indexers) b.indexers.push(`${substitute(ix.type, subst)} ${ix.name}[${ix.params.map((p) => substitute(p, subst)).join(', ')}]`);
    for (const parentRaw of [t.extends, ...t.interfaces]) {
      if (!parentRaw || ROOT_BASES.has(parentRaw)) continue;
      const parent = substitute(parentRaw, subst);
      const { key: pk, args } = parseTypeRef(parent);
      const pt = this.types.get(pk);
      if (pt && args.length === pt.genericParams.length) {
        const ps = Object.fromEntries(args.map((a, i) => [pt.genericParams[i], a]));
        const pairs = args.length ? ` [${pt.genericParams.map((g, i) => `${g}=${shortNs(args[i])}`).join(', ')}]` : '';
        this.collect(pk, ps, display, [...chain, `inherited from ${shortNs(pk)}${pairs}`], b, seen);
      } else if (Object.hasOwn(BCL_CONTRACTS, pk)) {
        const c = BCL_CONTRACTS[pk];
        const cs = Object.fromEntries(args.map((a, i) => [c.params[i], a]));
        b.bcl.add(parent);
        for (const m of c.methods) {
          const sig = `${display}::${substitute(m, cs)}`;
          bind(b.methods, sig, { via: 'bcl', chain: [...chain, `BCL contract ${shortNs(parent)} (not in dump)`], substituted: substitute(m, cs) !== m });
        }
      } else {
        b.external.add(parent);
      }
    }
  }

  nearestTypes(decl: string, n = 3): string[] {
    const { key } = parseTypeRef(decl);
    const leaf = key.slice(key.lastIndexOf('.') + 1).split('`')[0].toLowerCase();
    return [...this.types.keys()]
      .map((k) => ({ k, d: distance(leaf, k.slice(k.lastIndexOf('.') + 1).split('`')[0].toLowerCase()) }))
      .sort((x, y) => x.d - y.d || x.k.localeCompare(y.k))
      .slice(0, n)
      .map((x) => x.k);
  }
}

/** Reachable along several paths (e.g. IDisposable directly and via a base): keep the shortest chain. */
function bind(map: Map<string, Binding>, key: string, binding: Binding): void {
  const existing = map.get(key);
  if (!existing || binding.chain.length < existing.chain.length) map.set(key, binding);
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// ---------------------------------------------------------------------------
// SDK vs dump
// ---------------------------------------------------------------------------

export type DriftCode = 'METHOD_DRIFT' | 'MEMBER_DRIFT' | 'TYPE_DRIFT';
export interface Diagnostic { code: DriftCode | 'CATALOG_MISMATCH'; name: string; sites: Site[]; reason: string; candidates: string[]; hints: string[] }
export interface BindingRecord { kind: 'method' | 'member'; name: string; binding: Binding }
export interface Comparison {
  drift: Diagnostic[];
  bindings: BindingRecord[];
  checked: Record<WireKind, number>;
  bcl: string[];
  external: string[];
}

const wireLabel = (w: WireName) => (w.kind === 'shortMember' ? `${w.owner}::${w.name}` : w.name);

export function compare(inv: Inventory, model: DumpModel): Comparison {
  const drift: Diagnostic[] = [];
  const bindings: BindingRecord[] = [];
  const checked: Record<WireKind, number> = { method: 0, member: 0, type: 0, shortMember: 0 };
  const bcl = new Set<string>();
  const external = new Set<string>();
  const nsHint = (s: string) => (s.includes(METADATA_NS) ? [NS_HINT] : []);
  const note = (b: Bound) => {
    b.bcl.forEach((x) => bcl.add(x));
    b.external.forEach((x) => external.add(x));
  };

  for (const w of inv.names) {
    checked[w.kind]++;
    const diag = (code: DriftCode, reason: string, candidates: string[], hints: string[] = []) =>
      drift.push({ code, name: wireLabel(w), sites: w.sites, reason, candidates, hints: [...nsHint(w.kind === 'shortMember' ? w.owner! : w.name), ...hints] });

    if (w.kind === 'method') {
      const sig = parseMethodSig(w.name)!;
      const b = model.bound(sig.decl);
      if (typeof b === 'string') {
        diag('METHOD_DRIFT', b, model.nearestTypes(sig.decl));
        continue;
      }
      note(b);
      const hit = b.methods.get(w.name);
      if (hit) {
        bindings.push({ kind: 'method', name: w.name, binding: hit });
        continue;
      }
      const sameName = [...b.methods.keys()].filter((k) => parseMethodSig(k)?.name === sig.name).sort();
      const candidates = sameName.length
        ? sameName
        : [...b.methods.keys()]
          .map((k) => ({ k, d: distance(sig.name, parseMethodSig(k)!.name) }))
          .sort((x, y) => x.d - y.d || x.k.localeCompare(y.k))
          .slice(0, 3)
          .map((x) => x.k);
      const unrelated = (model.declaredBy.get(`${sig.name}(${sig.params})`) ?? []).filter((k) => !b.ancestors.has(k));
      const hints = unrelated.length
        ? [`${sig.name}(${sig.params}) is declared on unrelated type(s) ${unrelated.map(shortNs).join(', ')} — no inheritance path from ${shortNs(sig.decl)}, not a match`]
        : [];
      diag('METHOD_DRIFT', sameName.length ? 'parameter list differs' : `no method ${sig.name} on ${sig.decl}`, candidates, hints);
    } else if (w.kind === 'member' || w.kind === 'shortMember') {
      const decl = w.kind === 'member' ? parseMember(w.name)!.decl : w.owner!;
      const memberName = w.kind === 'member' ? parseMember(w.name)!.name : w.name;
      const b = model.bound(decl);
      if (typeof b === 'string') {
        diag('MEMBER_DRIFT', b, model.nearestTypes(decl));
        continue;
      }
      note(b);
      const sameName = b.memberNames.get(memberName) ?? [];
      const hit = w.kind === 'member' ? b.members.get(w.name) : sameName.length ? b.members.get(sameName[0]) : undefined;
      if (hit) {
        bindings.push({ kind: 'member', name: wireLabel(w), binding: hit });
        continue;
      }
      const indexer = b.indexers.filter((ix) => ix.split(' ').pop()!.startsWith(`${memberName}[`));
      const hints = indexer.length ? [`${shortNs(decl)} declares indexer ${shortNs(indexer[0])} — an indexer is not a by-value member`] : [];
      const candidates = sameName.length
        ? sameName
        : [...b.memberNames.keys()]
          .map((k) => ({ k, d: distance(memberName, k) }))
          .sort((x, y) => x.d - y.d || x.k.localeCompare(y.k))
          .slice(0, 3)
          .flatMap((x) => b.memberNames.get(x.k)!);
      diag('MEMBER_DRIFT', sameName.length ? 'member type differs' : `no member ${memberName} on ${decl}`, candidates, hints);
    } else {
      const b = model.bound(w.name);
      if (typeof b === 'string') diag('TYPE_DRIFT', b, model.nearestTypes(w.name));
    }
  }
  return { drift: sortDiagnostics(drift), bindings, checked, bcl: [...bcl].sort(), external: [...external].sort() };
}

function sortDiagnostics<T extends Diagnostic>(ds: T[]): T[] {
  return ds.sort((a, b) => a.code.localeCompare(b.code) || a.sites[0].file.localeCompare(b.sites[0].file) || a.sites[0].line - b.sites[0].line || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Committed catalog (provenance)
// ---------------------------------------------------------------------------

interface CatalogStruct { members: { name: string; type: string }[] }
export class CatalogModel {
  readonly methods = new Set<string>();
  readonly types = new Set<string>();
  readonly structs = new Map<string, CatalogStruct>();
  readonly source: string;

  constructor(raw: any) {
    if (!Array.isArray(raw?.services) || typeof raw?.structs !== 'object') throw new InputError('catalog: missing services[]/structs');
    this.source = String(raw.source ?? 'catalog');
    // Same evidenced alias the generator applies (tools/gen_client.ts wireName).
    const json = JSON.parse(JSON.stringify({ ...raw, source: undefined }).split(METADATA_NS).join(WIRE_NS));
    for (const s of json.services) {
      this.types.add(s.fullName);
      for (const m of s.methods) this.methods.add(m.signature);
    }
    for (const [k, v] of Object.entries(json.structs as Record<string, CatalogStruct>)) {
      this.structs.set(k, v);
      this.types.add(k);
    }
    for (const k of Object.keys(json.typeKinds ?? {})) this.types.add(k);
    for (const e of json.enums ?? []) this.types.add(e.name);
  }

  /** Member strings for a wire declaring type; closed generics substitute the free names in order. */
  membersOf(decl: string): Set<string> | undefined {
    const { key, args } = parseTypeRef(decl);
    const s = this.structs.get(key);
    if (!s) return undefined;
    let subst: Record<string, string> = {};
    if (args.length) {
      const free: string[] = [];
      for (const m of s.members) {
        for (const id of m.type.match(/(?<![\w.`])[A-Za-z_]\w*(?![\w.`])/g) ?? []) {
          if (!KEYWORD_TYPES.has(id) && !free.includes(id)) free.push(id);
        }
      }
      if (free.length !== args.length) return undefined;
      subst = Object.fromEntries(free.map((f, i) => [f, args[i]]));
    }
    return new Set(s.members.map((m) => `${substitute(m.type, subst)} ${decl}::${m.name}`));
  }
}
const KEYWORD_TYPES = new Set(['bool', 'int', 'long', 'double', 'float', 'string', 'char', 'short', 'object', 'void', 'uint', 'ulong']);

export function loadCatalog(file = DEFAULT_CATALOG): CatalogModel {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new InputError(`${file}: unreadable catalog (${(err as Error).message})`);
  }
  return new CatalogModel(raw);
}

export function compareCatalog(inv: Inventory, cat: CatalogModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const w of inv.names) {
    let reason: string | undefined;
    if (w.kind === 'method') {
      if (!cat.methods.has(w.name)) reason = 'signature not in the committed catalog';
    } else if (w.kind === 'member') {
      const p = parseMember(w.name)!;
      const ms = cat.membersOf(p.decl);
      if (!ms) reason = `catalog has no struct schema for ${p.decl}`;
      else if (!ms.has(w.name)) reason = 'member not in the committed catalog';
    } else if (w.kind === 'shortMember') {
      const ms = cat.membersOf(w.owner!);
      if (!ms || ![...ms].some((m) => m.endsWith(`::${w.name}`))) reason = `catalog has no member ${w.name} on ${w.owner}`;
    } else if (!cat.types.has(parseTypeRef(w.name).key)) reason = 'type not in the committed catalog';
    if (reason) out.push({ code: 'CATALOG_MISMATCH', name: wireLabel(w), sites: w.sites, reason, candidates: [], hints: w.name.includes(METADATA_NS) ? [NS_HINT] : [] });
  }
  return sortDiagnostics(out);
}

/** What the committed catalog and the dump disagree on (reported, not failed). */
export function catalogDelta(cat: CatalogModel, model: DumpModel) {
  const dumpSigs = new Set<string>();
  const dumpMembers = new Set<string>();
  for (const [key, t] of model.types) {
    if (!key.startsWith(WIRE_NS)) continue;
    const b = model.bound(key);
    if (typeof b === 'string') continue;
    if (t.kind === 'interface') b.methods.forEach((_, sig) => dumpSigs.add(sig));
    if (t.attributes.includes('ByValAttribute')) b.members.forEach((_, m) => dumpMembers.add(m));
  }
  const catMembers = new Set<string>();
  for (const [key, s] of cat.structs) for (const m of s.members) catMembers.add(`${m.type} ${key}::${m.name}`);
  const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
  // Catalog rows contributed by interfaces outside this assembly (System.IChanged<T>,
  // System.IDataSource) cannot be confirmed or refuted from the dump: keep them apart.
  const external = (sig: string) => {
    const b = model.bound(parseMethodSig(sig)?.decl ?? '');
    return typeof b !== 'string' && b.external.size > 0 && !b.methods.has(sig);
  };
  const onlyCatalogAll = diff(cat.methods, dumpSigs);
  return {
    signatures: {
      onlyCatalog: onlyCatalogAll.filter((x) => !external(x)),
      onlyCatalogExternal: onlyCatalogAll.filter(external),
      onlyDump: diff(dumpSigs, cat.methods),
      catalog: cat.methods.size,
      dump: dumpSigs.size,
    },
    members: { onlyCatalog: diff(catMembers, dumpMembers), onlyDump: diff(dumpMembers, catMembers), catalog: catMembers.size, dump: dumpMembers.size },
  };
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

interface FixtureWire { kind: WireKind; name: string; owner?: string }
interface FixtureExpect {
  drift: { code: DriftCode; name: string; hint?: string }[];
  bindings: { name: string; via: Via; chain?: string[]; substituted?: boolean }[];
  namespaceAlias: boolean;
}

export function runFixture(dir: string): { name: string; errors: string[]; comparison: Comparison; model: DumpModel } {
  const name = path.basename(dir);
  const model = new DumpModel(loadDump(path.join(dir, 'dump.json')));
  const wire: { names: FixtureWire[] } = JSON.parse(fs.readFileSync(path.join(dir, 'wire.json'), 'utf8'));
  const expect: FixtureExpect = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const inv: Inventory = {
    names: wire.names.map((w, i) => ({ ...w, origins: ['fixture'], sites: [{ file: `tools/fixtures/signature-drift/${name}/wire.json`, line: i + 1 }] })),
    unresolved: [],
    files: [],
  };
  const comparison = compare(inv, model);
  const errors: string[] = [];
  const got = comparison.drift.map((d) => `${d.code} ${d.name}`).sort();
  const want = expect.drift.map((d) => `${d.code} ${d.name}`).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) errors.push(`drift set\n      expected: ${JSON.stringify(want)}\n      got:      ${JSON.stringify(got)}`);
  for (const d of expect.drift) {
    if (!d.hint) continue;
    const hit = comparison.drift.find((x) => x.code === d.code && x.name === d.name);
    if (hit && !hit.hints.some((h) => h.includes(d.hint!))) errors.push(`${d.name}: missing hint containing "${d.hint}"`);
  }
  for (const e of expect.bindings) {
    const b = comparison.bindings.find((x) => x.name === e.name);
    if (!b) errors.push(`binding missing: ${e.name}`);
    else {
      if (b.binding.via !== e.via) errors.push(`${e.name}: via ${b.binding.via}, expected ${e.via}`);
      if (e.chain && JSON.stringify(b.binding.chain) !== JSON.stringify(e.chain)) errors.push(`${e.name}: chain ${JSON.stringify(b.binding.chain)}, expected ${JSON.stringify(e.chain)}`);
      if (e.substituted !== undefined && b.binding.substituted !== e.substituted) errors.push(`${e.name}: substituted=${b.binding.substituted}, expected ${e.substituted}`);
    }
  }
  if ((model.aliased > 0) !== expect.namespaceAlias) errors.push(`namespace alias: ${model.aliased} names normalized, expected ${expect.namespaceAlias ? 'some' : 'none'}`);
  return { name, errors, comparison, model };
}

/** Inventory floors: a regression in extraction must not pass as "no drift". */
export const INVENTORY_FLOOR = { method: 1200, member: 1500, type: 250, shortMember: 3, handwrittenMethods: 15, unresolvedMax: 40 };

export function inventoryProblems(inv: Inventory): string[] {
  const count = (k: WireKind) => inv.names.filter((w) => w.kind === k).length;
  const handwritten = inv.names.filter((w) => w.kind === 'method' && w.origins.some((o) => o !== 'generated')).length;
  const problems: string[] = [];
  for (const k of ['method', 'member', 'type', 'shortMember'] as const) {
    if (count(k) < INVENTORY_FLOOR[k]) problems.push(`only ${count(k)} ${k} names extracted (floor ${INVENTORY_FLOOR[k]})`);
  }
  if (handwritten < INVENTORY_FLOOR.handwrittenMethods) problems.push(`only ${handwritten} handwritten/call-site method signatures (floor ${INVENTORY_FLOOR.handwrittenMethods})`);
  if (inv.unresolved.length > INVENTORY_FLOOR.unresolvedMax) problems.push(`${inv.unresolved.length} unresolved sites (max ${INVENTORY_FLOOR.unresolvedMax})`);
  return problems;
}

const INPUT_ERROR_CASES: [string, string | Buffer, RegExp][] = [
  ['PE bytes', Buffer.from('MZ\x90\x00\x03', 'latin1'), /PE\/DLL, not a dump/],
  ['not JSON', '{"format":', /not JSON/],
  ['wrong format', '{"format":"something-else","formatVersion":1,"types":[]}', /not a roon-broker-api-dump/],
  ['malformed type', `{"format":"${DUMP_FORMAT}","formatVersion":1,"types":[{"name":"Sooloos.Broker.Api.X","methods":[{"name":1}]}]}`, /malformed/],
  ['foreign', `{"format":"${DUMP_FORMAT}","formatVersion":1,"types":[{"name":"Contoso.Widgets.Gear"}]}`, /foreign input/],
];

export function selfTest(log: (s: string) => void = console.log): boolean {
  let ok = true;
  const dirs = fs.readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(FIXTURES, d.name)).sort();
  if (dirs.length < 4) {
    log(`self-test: expected 4 fixtures in ${path.relative(PKG_ROOT, FIXTURES)}, found ${dirs.length}`);
    ok = false;
  }
  for (const dir of dirs) {
    const r = runFixture(dir);
    const summary = `${r.comparison.drift.length} drift, ${r.comparison.bindings.length} bindings, ${r.model.aliased} aliased`;
    if (r.errors.length) {
      ok = false;
      log(`self-test FAIL ${r.name} (${summary})`);
      for (const e of r.errors) log(`    ${e}`);
    } else log(`self-test ok   ${r.name} (${summary})`);
  }
  for (const [label, input, re] of INPUT_ERROR_CASES) {
    try {
      parseDump(input, label);
      ok = false;
      log(`self-test FAIL input "${label}" was accepted`);
    } catch (err) {
      const pass = err instanceof InputError && re.test(err.message);
      if (!pass) {
        ok = false;
        log(`self-test FAIL input "${label}": ${(err as Error).message}`);
      }
    }
  }
  log(`self-test ok   ${INPUT_ERROR_CASES.length} invalid inputs rejected as INPUT_ERROR`);
  const inv = extractInventory();
  const problems = inventoryProblems(inv);
  const counts = inventoryCounts(inv);
  if (problems.length) {
    ok = false;
    for (const p of problems) log(`self-test FAIL SDK inventory: ${p}`);
  } else log(`self-test ok   SDK inventory: ${counts}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Reporting + CLI
// ---------------------------------------------------------------------------

function inventoryCounts(inv: Inventory): string {
  const c = (k: WireKind) => inv.names.filter((w) => w.kind === k).length;
  const hw = inv.names.filter((w) => w.kind === 'method' && w.origins.some((o) => o !== 'generated')).length;
  return `${c('method')} method signatures (${hw} handwritten/call-site), ${c('member')} members, ${c('type')} types, ${c('shortMember')} short members from ${inv.files.length} files; ${inv.unresolved.length} unresolved`;
}

function printDiagnostics(ds: Diagnostic[], log: (s: string) => void): void {
  for (const d of ds) {
    const s = d.sites[0];
    const more = d.sites.length > 1 ? ` (also ${d.sites.slice(1, 4).map((x) => `${x.file}:${x.line}`).join(', ')}${d.sites.length > 4 ? `, +${d.sites.length - 4} more` : ''})` : '';
    log(`${d.code} ${s.file}:${s.line}${more}`);
    log(`  wire: ${d.name}`);
    log(`  why:  ${d.reason}`);
    if (d.candidates.length) {
      log('  closest in DLL:');
      for (const c of d.candidates.slice(0, 6)) log(`    ${c}`);
      if (d.candidates.length > 6) log(`    (+${d.candidates.length - 6} more)`);
    }
    for (const h of d.hints) log(`  hint: ${h}`);
  }
}

function printUnresolved(inv: Inventory, log: (s: string) => void): void {
  if (!inv.unresolved.length) return;
  log(`UNRESOLVED ${inv.unresolved.length} site(s) build wire names from runtime-only values (not checkable statically):`);
  for (const u of inv.unresolved) log(`  ${u.site.file}:${u.site.line}  ${u.reason}: ${u.expr}`);
}

const USAGE = `usage: ts-node tools/check_signatures.ts (--dump PATH | --catalog-only | --self-test) [--catalog PATH]
  --dump PATH      compare the SDK's wire names with a dump from tools/dump_broker_api.py
  --catalog-only   compare the SDK's wire names with the committed catalog (no DLL needed)
  --self-test      run the synthetic fixtures and SDK-inventory sanity checks
  --catalog PATH   catalog to use (default src/catalog/catalog.authoritative.json)
exit: 0 clean, 1 drift or catalog mismatch, 2 input or usage error`;

export function main(argv: string[], log: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const opts: { dump?: string; catalog?: string; catalogOnly?: boolean; selfTest?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dump' || a === '--catalog') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        err(`${a} needs a path\n${USAGE}`);
        return 2;
      }
      if (a === '--dump') opts.dump = v;
      else opts.catalog = v;
    } else if (a === '--catalog-only') opts.catalogOnly = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--help' || a === '-h') {
      log(USAGE);
      return 0;
    } else {
      err(`unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  const modes = [opts.dump !== undefined, !!opts.catalogOnly, !!opts.selfTest].filter(Boolean).length;
  if (modes !== 1) {
    err(`choose exactly one of --dump PATH, --catalog-only, --self-test\n${USAGE}`);
    return 2;
  }
  try {
    if (opts.selfTest) return selfTest(log) ? 0 : 1;

    const inv = extractInventory();
    log(`SDK inventory: ${inventoryCounts(inv)}`);
    const problems = inventoryProblems(inv);
    if (problems.length) {
      for (const p of problems) err(`INPUT_ERROR SDK inventory implausible: ${p}`);
      return 2;
    }
    const catalog = loadCatalog(opts.catalog);
    const mismatches = compareCatalog(inv, catalog);
    printUnresolved(inv, log);

    let drift: Diagnostic[] = [];
    if (opts.dump !== undefined) {
      const model = new DumpModel(loadDump(opts.dump));
      const asm = model.dump.assembly ?? {};
      log(`DLL dump: ${opts.dump} (${model.types.size} types${asm.sha256 ? `, sha256 ${String(asm.sha256).slice(0, 12)}…` : ''})`);
      if (model.aliased) {
        log(`NAMESPACE_ALIAS the dump declares ${METADATA_NS}*; ${model.aliased} metadata names normalized to the wire's ${WIRE_NS}* (#15). Wire names are compared verbatim.`);
      }
      const cmp = compare(inv, model);
      drift = cmp.drift;
      const inherited = cmp.bindings.filter((b) => b.binding.via !== 'declared');
      const viaBcl = inherited.filter((b) => b.binding.via === 'bcl').length;
      const substituted = cmp.bindings.filter((b) => b.binding.substituted).length;
      log(`bindings: ${cmp.bindings.length} matched; ${inherited.length} inherited-bound (${viaBcl} through BCL contracts), ${substituted} generic-substituted`);
      if (cmp.bcl.length) log(`BCL contracts modeled (absent from the dump): ${cmp.bcl.map(shortNs).join(', ')}`);
      if (cmp.external.length) log(`external interfaces not in the dump (their members are not modeled): ${cmp.external.map(shortNs).join(', ')}`);
      const delta = catalogDelta(catalog, model);
      log(`catalog-vs-dump delta: signatures ${delta.signatures.onlyCatalog.length} only in catalog / ${delta.signatures.onlyDump.length} only in dump` +
        ` (+${delta.signatures.onlyCatalogExternal.length} catalog rows from external interfaces, unverifiable); members ${delta.members.onlyCatalog.length} / ${delta.members.onlyDump.length}`);
      for (const [label, xs] of [
        ['signature only in catalog', delta.signatures.onlyCatalog], ['signature only in dump', delta.signatures.onlyDump],
        ['member only in catalog', delta.members.onlyCatalog], ['member only in dump', delta.members.onlyDump],
      ] as const) {
        for (const x of xs.slice(0, 25)) log(`  ${label}: ${x}`);
        if (xs.length > 25) log(`  (+${xs.length - 25} more ${label})`);
      }
    }

    printDiagnostics(drift, err);
    printDiagnostics(mismatches, err);
    const verdict = [
      opts.dump !== undefined ? `${drift.length} drift` : undefined,
      `${mismatches.length} catalog mismatch${mismatches.length === 1 ? '' : 'es'}`,
    ].filter(Boolean).join(', ');
    if (drift.length || mismatches.length) {
      err(`FAIL: ${verdict}`);
      return 1;
    }
    log(`ok: ${verdict} (catalog: ${catalog.source})`);
    return 0;
  } catch (e) {
    if (e instanceof InputError) {
      err(`INPUT_ERROR ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
