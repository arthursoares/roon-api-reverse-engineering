/**
 * Format a method into the exact wire DEFMETHOD signature string the Roon
 * server expects, e.g.:
 *   Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)
 *
 * Mapping rules were derived from the C# decompilation and **validated** against
 * 67 ground-truth DEFMETHOD strings captured from the official client
 * (signature.test.ts).
 */

const API_NS = 'Sooloos.Broker.Api.';

// C# keyword primitives keep their lowercase keyword form on the wire.
const KEYWORD_PRIMITIVES = new Set([
  'string', 'bool', 'double', 'long', 'int', 'float', 'char', 'short', 'object', 'void',
]);

// Explicit short -> fully-qualified remoting names.
const EXPLICIT: Record<string, string> = {
  Sooid: 'System.Sooid',
  Guid: 'System.Guid',
  DateTime: 'System.DateTime',
  TimeSpan: 'System.TimeSpan',
  ResultCallback: 'Base.ResultCallback',
  ResultPromise: 'Base.ResultPromise',
  // byte[] is handled specially (System.Byte[]) in formatType.
};

// Generic containers -> their FQ namespace.
const GENERIC_NS: Record<string, string> = {
  IEnumerable: 'System.Collections.Generic.IEnumerable',
  IList: 'System.Collections.Generic.IList',
  IReadOnlyList: 'System.Collections.Generic.IReadOnlyList',
  ICollection: 'System.Collections.Generic.ICollection',
  List: 'System.Collections.Generic.List',
  IDictionary: 'System.Collections.Generic.IDictionary',
  Dictionary: 'System.Collections.Generic.Dictionary',
  Nullable: 'System.Nullable',
};

/** Split generic args on top-level commas. */
function splitGeneric(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Format a single C# type token into its wire FQ name. */
export function formatType(t: string): string {
  t = t.trim();

  // Nullable shorthand "T?"
  if (t.endsWith('?')) {
    return formatType(t.slice(0, -1)) + '?';
  }

  // Arrays: byte[] -> System.Byte[], T[] -> <FQ T>[]
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2).trim();
    if (inner === 'byte') return 'System.Byte[]';
    return formatType(inner) + '[]';
  }

  // Generic: Outer<args>
  const gm = t.match(/^([A-Za-z0-9_]+)<(.+)>$/);
  if (gm) {
    const outer = gm[1];
    const args = splitGeneric(gm[2]).map(formatType).join(', ');
    if (outer === 'ResultCallback') return `Base.ResultCallback<${args}>`;
    if (outer === 'ResultPromise') return `Base.ResultPromise<${args}>`;
    if (GENERIC_NS[outer]) return `${GENERIC_NS[outer]}<${args}>`;
    // Generic types defined in the API namespace (Query<T>, DataList<T>, etc.)
    return `${API_NS}${outer}<${args}>`;
  }

  if (KEYWORD_PRIMITIVES.has(t)) return t;
  if (EXPLICIT[t]) return EXPLICIT[t];
  // Everything else is an API type.
  return `${API_NS}${t}`;
}

export interface CatalogParam {
  type: string;
  name: string;
}

/**
 * Build the full wire signature string for a method on a service interface.
 * `service` is the bare interface name (e.g. "Library").
 */
export function formatMethodSignature(
  service: string,
  method: string,
  params: CatalogParam[]
): string {
  const args = params.map((p) => formatType(p.type)).join(', ');
  return `${API_NS}${service}::${method}(${args})`;
}
