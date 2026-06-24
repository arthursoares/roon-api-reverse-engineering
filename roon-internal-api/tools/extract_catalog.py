#!/usr/bin/env python3
"""
Extract the full Roon internal API catalog from the decompiled Roon.Broker.Api.dll
into catalog.json.

Source: ilspycmd output of Roon.Broker.Api.dll (decompiled C# interfaces).
Each service interface declares methods; we capture name, ordered params
(name + C# type), return type, and whether a ResultCallback is present
(=> expects a response on the wire).

The wire DEFMETHOD signature string uses fully-qualified remoting type names
(e.g. Sooid -> System.Sooid, ResultCallback -> Base.ResultCallback,
TrackBase -> Sooloos.Broker.Api.TrackBase). We compute a best-effort FQ
signature and (separately) validate the formatting against captured ground
truth in tools/validate_catalog.py.
"""
import re, json, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/roon-decomp/api/Roon.Broker.Api.decompiled.cs'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'src/catalog/catalog.json'

# Service interfaces are those whose methods carry ResultCallback. We capture
# every interface and mark which are "services" (callable) vs data types.
iface_re = re.compile(r'^\s*public interface ([A-Za-z0-9_]+)(<[^>]*>)?\s*(?::\s*(.+?))?\s*$')
# method decl: "ReturnType Name(params);" inside an interface
method_re = re.compile(r'^\s*([A-Za-z0-9_<>,\.\[\] \?]+?)\s+([A-Za-z0-9_]+)\s*\((.*)\)\s*;\s*$')

def split_params(s):
    """Split a C# parameter list on top-level commas (respecting < > nesting)."""
    out, depth, cur = [], 0, ''
    for ch in s:
        if ch in '<([': depth += 1
        elif ch in '>)]': depth -= 1
        if ch == ',' and depth == 0:
            out.append(cur.strip()); cur = ''
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out

def parse_param(p):
    # strip default values
    p = p.split('=')[0].strip()
    # "Type name" — name is last token; type is the rest
    m = re.match(r'^(.*\S)\s+([A-Za-z0-9_]+)$', p)
    if not m:
        return {'type': p, 'name': ''}
    return {'type': m.group(1).strip(), 'name': m.group(2)}

def main():
    lines = open(SRC).read().splitlines()
    methods_by_iface = {}   # bare name -> [methods]
    extends_by_iface = {}   # bare name -> [base bare names]
    cur_iface = None
    depth = 0

    def base_names(clause):
        """Parse 'VirtualQuery<AlbumLite, AlbumBase>, IDisposable' -> ['VirtualQuery']."""
        out = []
        for b in split_params(clause):
            b = b.strip()
            m = re.match(r'^([A-Za-z0-9_]+)', b)
            if m:
                out.append(m.group(1))
        return out

    for ln in lines:
        # Strip generic-constraint clauses ("where T : ...") so interfaces with
        # constraints (e.g. Browser<TSelf, TItem> where TSelf : ...) are detected.
        ln_iface = re.split(r'\bwhere\b', ln)[0].rstrip()
        im = iface_re.match(ln_iface)
        if im and 'interface ' in ln:
            cur_iface = im.group(1)
            methods_by_iface.setdefault(cur_iface, [])
            extends_by_iface[cur_iface] = base_names(im.group(3)) if im.group(3) else []
            depth = 0
        if cur_iface:
            depth += ln.count('{') - ln.count('}')
        mm = method_re.match(ln)
        if mm and cur_iface and 'interface ' not in ln and 'class ' not in ln:
            ret, name, params = mm.group(1).strip(), mm.group(2), mm.group(3)
            ps = [parse_param(p) for p in split_params(params)] if params.strip() else []
            has_cb = any('ResultCallback' in p['type'] for p in ps)
            ret_type = None
            for p in ps:
                cbm = re.search(r'ResultCallback<(.+)>', p['type'])
                if cbm:
                    ret_type = cbm.group(1)
            methods_by_iface[cur_iface].append({
                'name': name,
                'params': ps,
                'returns': ret_type,
                'expectsResponse': has_cb or ret != 'void',
                'csharpReturn': ret,
            })
        if cur_iface and depth <= 0 and '}' in ln:
            cur_iface = None

    # Resolve inherited methods: a concrete type is registered on the wire under
    # its own name but inherits methods from its base interfaces (e.g.
    # VirtualAlbumLiteQuery : VirtualQuery<...> inherits RetainPage).
    def resolve(name, seen=None):
        seen = seen or set()
        if name in seen or name not in methods_by_iface:
            return []
        seen.add(name)
        out = list(methods_by_iface.get(name, []))
        for base in extends_by_iface.get(name, []):
            out.extend(resolve(base, seen))
        return out

    services = {}
    for name in methods_by_iface:
        resolved = resolve(name)
        if resolved:
            services[name] = resolved

    total = sum(len(v) for v in services.values())
    catalog = {
        'source': 'Roon.Broker.Api.dll (decompiled)',
        'serviceCount': len(services),
        'methodCount': total,
        'extends': extends_by_iface,
        'services': services,
    }
    import os
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    print(f"wrote {OUT}: {len(services)} interfaces, {total} methods")
    # top services by method count
    top = sorted(services.items(), key=lambda kv: -len(kv[1]))[:12]
    for name, ms in top:
        print(f"  {name}: {len(ms)}")

if __name__ == '__main__':
    main()
