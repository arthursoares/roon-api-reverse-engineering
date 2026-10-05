#!/usr/bin/env python3
"""
Dump the declared API surface of Roon.Broker.Api.dll as JSON, for
tools/check_signatures.ts.

Reads ECMA-335 metadata directly (dnfile), so it needs neither the .NET runtime
nor a decompiler. For every type it records ONLY what that type itself
declares: methods (incl. property/event accessors), properties (indexers
kept apart), generic parameter names, base type, implemented interfaces and
custom attribute names.
Inheritance, generic substitution and namespace aliasing are deliberately NOT
applied here; the checker models them explicitly so every binding it accepts
is visible in its report.

Type names use the wire rendering of the authoritative catalog (oracle/):
C# keywords for the common primitives, `T?` for Nullable<T>, `System.Byte[]`,
closed generics as `Ns.Name<A, B>`, generic parameters by their declared name.
Metadata namespaces are emitted verbatim (Roon.Broker.Api.* on Roon >= 2.71).

The output contains names and signatures only, never IL or resources. It is
derived from proprietary software: keep dumps out of the repository.

Usage:
  pip install dnfile
  python3 tools/dump_broker_api.py --dll /path/to/Roon.Broker.Api.dll --out dump.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

FORMAT = 'roon-broker-api-dump'
FORMAT_VERSION = 1

# ECMA-335 II.23.1.16 element types, rendered like oracle/Program.cs TypeName.
PRIMITIVES = {
    0x01: 'void', 0x02: 'bool', 0x03: 'char', 0x04: 'System.SByte', 0x05: 'System.Byte',
    0x06: 'short', 0x07: 'System.UInt16', 0x08: 'int', 0x09: 'uint', 0x0A: 'long',
    0x0B: 'ulong', 0x0C: 'float', 0x0D: 'double', 0x0E: 'string', 0x18: 'System.IntPtr',
    0x19: 'System.UIntPtr', 0x1C: 'object', 0x16: 'System.TypedReference',
}
# Keyword spellings when the same types arrive as TypeRefs (e.g. generic args
# are always element types, but CLASS/VALUETYPE tokens can name them too).
KEYWORDS = {
    'System.Boolean': 'bool', 'System.Int32': 'int', 'System.Int64': 'long',
    'System.Double': 'double', 'System.Single': 'float', 'System.String': 'string',
    'System.Char': 'char', 'System.Object': 'object', 'System.Void': 'void',
    'System.Int16': 'short', 'System.UInt32': 'uint', 'System.UInt64': 'ulong',
}
ACCESSOR_PREFIXES = ('get_', 'set_', 'add_', 'remove_')


class DumpError(Exception):
    pass


def read_compressed(blob: bytes, pos: int) -> tuple[int, int]:
    b = blob[pos]
    if b & 0x80 == 0:
        return b, pos + 1
    if b & 0xC0 == 0x80:
        return ((b & 0x3F) << 8) | blob[pos + 1], pos + 2
    return ((b & 0x1F) << 24) | (blob[pos + 1] << 16) | (blob[pos + 2] << 8) | blob[pos + 3], pos + 4


def table_name(coded) -> str:
    table = getattr(coded, 'table', None)
    return getattr(table, 'name', type(table).__name__) if table is not None else ''


def blob_bytes(value) -> bytes:
    return bytes(value.value if hasattr(value, 'value') else value)


class Dumper:
    def __init__(self, path: str):
        import dnfile  # imported lazily so --help works without it

        try:
            self.pe = dnfile.dnPE(path)
        except Exception as exc:  # noqa: BLE001 - dnfile raises many types
            raise DumpError(f'not a readable PE/.NET file: {exc}') from exc
        net = getattr(self.pe, 'net', None)
        if net is None or net.mdtables is None or net.mdtables.TypeDef is None:
            raise DumpError('no .NET metadata in this file')
        self.md = net.mdtables
        self.type_params: dict[int, list[str]] = {}
        self.method_params: dict[int, list[str]] = {}
        for gp in self.md.GenericParam.rows if self.md.GenericParam else []:
            owner = gp.Owner
            target = self.type_params if table_name(owner) == 'TypeDef' else self.method_params
            names = target.setdefault(owner.row_index, [])
            while len(names) <= gp.Number:
                names.append('')
            names[gp.Number] = str(gp.Name)
        self.enclosing: dict[int, int] = {}
        for nc in self.md.NestedClass.rows if self.md.NestedClass else []:
            self.enclosing[nc.NestedClass.row_index] = nc.EnclosingClass.row_index
        self.method_owner: dict[int, int] = {}
        for ti, td in enumerate(self.md.TypeDef.rows, start=1):
            for m in td.MethodList or []:
                self.method_owner[m.row_index] = ti

    # --- names -------------------------------------------------------------
    def typedef_name(self, index: int) -> str:
        td = self.md.TypeDef.rows[index - 1]
        name = str(td.TypeName)
        if index in self.enclosing:
            return f'{self.typedef_name(self.enclosing[index])}+{name}'
        ns = str(td.TypeNamespace or '')
        return f'{ns}.{name}' if ns else name

    def typeref_name(self, index: int) -> str:
        tr = self.md.TypeRef.rows[index - 1]
        name = str(tr.TypeName)
        scope = tr.ResolutionScope
        if scope is not None and table_name(scope) == 'TypeRef' and scope.row_index:
            return f'{self.typeref_name(scope.row_index)}+{name}'
        ns = str(tr.TypeNamespace or '')
        return f'{ns}.{name}' if ns else name

    @staticmethod
    def display(full: str, args: list[str] | None = None) -> str:
        """Strip the generic arity tick; apply keyword and Nullable spellings."""
        base = full.split('`')[0] if '`' in full else full
        if args is None:
            return KEYWORDS.get(base, base)
        if base == 'System.Nullable' and len(args) == 1:
            return f'{args[0]}?'
        return f'{base}<{", ".join(args)}>'

    def coded_type(self, coded, ctx) -> str:
        """TypeDefOrRef coded index (InterfaceImpl, Extends) -> rendered name."""
        name = table_name(coded)
        if not coded.row_index:
            return ''
        if name == 'TypeDef':
            return self.display(self.typedef_name(coded.row_index))
        if name == 'TypeRef':
            return self.display(self.typeref_name(coded.row_index))
        if name == 'TypeSpec':
            blob = blob_bytes(self.md.TypeSpec.rows[coded.row_index - 1].Signature)
            return self.decode_type(blob, 0, ctx)[0]
        raise DumpError(f'unexpected TypeDefOrRef table {name}')

    def encoded_token(self, blob: bytes, pos: int, ctx) -> tuple[str, int]:
        """TypeDefOrRefOrSpecEncoded; returns the RAW full name (tick kept)."""
        val, pos = read_compressed(blob, pos)
        table, index = val & 0x03, val >> 2
        if table == 0:
            return self.typedef_name(index), pos
        if table == 1:
            return self.typeref_name(index), pos
        spec = blob_bytes(self.md.TypeSpec.rows[index - 1].Signature)
        return self.decode_type(spec, 0, ctx)[0], pos

    def decode_type(self, blob: bytes, pos: int, ctx) -> tuple[str, int]:
        et = blob[pos]
        pos += 1
        if et in PRIMITIVES:
            return PRIMITIVES[et], pos
        if et in (0x11, 0x12):  # VALUETYPE / CLASS
            raw, pos = self.encoded_token(blob, pos, ctx)
            return self.display(raw), pos
        if et == 0x15:  # GENERICINST
            raw, pos = self.encoded_token(blob, pos + 1, ctx)
            argc, pos = read_compressed(blob, pos)
            args = []
            for _ in range(argc):
                arg, pos = self.decode_type(blob, pos, ctx)
                args.append(arg)
            return self.display(raw, args), pos
        if et == 0x1D:  # SZARRAY
            inner, pos = self.decode_type(blob, pos, ctx)
            return f'{inner}[]', pos
        if et == 0x14:  # ARRAY (multi-dim): rank + sizes + lower bounds
            inner, pos = self.decode_type(blob, pos, ctx)
            rank, pos = read_compressed(blob, pos)
            for _ in range(2):
                count, pos = read_compressed(blob, pos)
                for _ in range(count):
                    _, pos = read_compressed(blob, pos)
            return f'{inner}[{"," * (rank - 1)}]', pos
        if et in (0x13, 0x1E):  # VAR / MVAR
            idx, pos = read_compressed(blob, pos)
            names = self.type_params.get(ctx[0], []) if et == 0x13 else self.method_params.get(ctx[1], [])
            prefix = '!' if et == 0x13 else '!!'
            return (names[idx] if idx < len(names) and names[idx] else f'{prefix}{idx}'), pos
        if et == 0x10:  # BYREF
            inner, pos = self.decode_type(blob, pos, ctx)
            return f'{inner}&', pos
        if et == 0x0F:  # PTR
            inner, pos = self.decode_type(blob, pos, ctx)
            return f'{inner}*', pos
        if et in (0x1F, 0x20):  # CMOD_REQD / CMOD_OPT: skip the modifier
            _, pos = read_compressed(blob, pos)
            return self.decode_type(blob, pos, ctx)
        if et == 0x45:  # PINNED
            return self.decode_type(blob, pos, ctx)
        raise DumpError(f'unsupported element type 0x{et:02x}')

    def method_sig(self, blob: bytes, ctx) -> tuple[str, list[str]]:
        pos = 1
        if blob[0] & 0x10:  # GENERIC: skip generic parameter count
            _, pos = read_compressed(blob, pos)
        count, pos = read_compressed(blob, pos)
        ret, pos = self.decode_type(blob, pos, ctx)
        params = []
        for _ in range(count):
            if blob[pos] == 0x41:  # SENTINEL (varargs) - not used by the API
                pos += 1
            p, pos = self.decode_type(blob, pos, ctx)
            params.append(p)
        return ret, params

    def property_sig(self, blob: bytes, ctx) -> tuple[str, list[str]]:
        """PropertySig -> (type, [index parameter types]); indexers have params."""
        if blob[0] & 0x08 == 0:
            raise DumpError('not a property signature')
        count, pos = read_compressed(blob, 1)
        ptype, pos = self.decode_type(blob, pos, ctx)
        params = []
        for _ in range(count):
            p, pos = self.decode_type(blob, pos, ctx)
            params.append(p)
        return ptype, params

    # --- attributes --------------------------------------------------------
    def attributes_by_type(self) -> dict[int, list[str]]:
        out: dict[int, list[str]] = {}
        for ca in self.md.CustomAttribute.rows if self.md.CustomAttribute else []:
            if table_name(ca.Parent) != 'TypeDef':
                continue
            ctor = ca.Type
            name = ''
            if table_name(ctor) == 'MethodDef':
                owner = self.method_owner.get(ctor.row_index)
                name = self.typedef_name(owner) if owner else ''
            elif table_name(ctor) == 'MemberRef':
                cls = self.md.MemberRef.rows[ctor.row_index - 1].Class
                if table_name(cls) == 'TypeRef':
                    name = self.typeref_name(cls.row_index)
                elif table_name(cls) == 'TypeDef':
                    name = self.typedef_name(cls.row_index)
            if name:
                out.setdefault(ca.Parent.row_index, []).append(name.rsplit('.', 1)[-1])
        return out

    # --- types -------------------------------------------------------------
    def kind_of(self, td, extends: str) -> str:
        if td.Flags.tdInterface:
            return 'interface'
        if extends == 'System.Enum':
            return 'enum'
        if extends == 'System.ValueType':
            return 'struct'
        if extends == 'System.MulticastDelegate':
            return 'delegate'
        return 'class'

    def dump(self) -> list[dict]:
        attrs = self.attributes_by_type()
        props_by_type: dict[int, list] = {}
        for pm in self.md.PropertyMap.rows if self.md.PropertyMap else []:
            props_by_type[pm.Parent.row_index] = [p.row for p in pm.PropertyList or [] if p.row is not None]
        impls: dict[int, list] = {}
        for ii in self.md.InterfaceImpl.rows if self.md.InterfaceImpl else []:
            impls.setdefault(ii.Class.row_index, []).append(ii.Interface)

        types = []
        for ti, td in enumerate(self.md.TypeDef.rows, start=1):
            raw = self.typedef_name(ti)
            if raw == '<Module>' or str(td.TypeName).startswith('<'):
                continue
            ctx = (ti, 0)
            extends = self.coded_type(td.Extends, ctx) if td.Extends is not None else ''
            methods = []
            for m in td.MethodList or []:
                row = m.row
                if row is None:
                    continue
                name = str(row.Name)
                if name in ('.ctor', '.cctor'):
                    continue
                ret, params = self.method_sig(blob_bytes(row.Signature), (ti, m.row_index))
                methods.append({'name': name, 'params': params, 'returns': ret})
            # Indexers (C# `this[...]`) are properties with parameters. They
            # can't be by-value members, so they are kept apart.
            properties, indexers = [], []
            for p in props_by_type.get(ti, []):
                ptype, params = self.property_sig(blob_bytes(p.Type), ctx)
                if params:
                    indexers.append({'name': str(p.Name), 'type': ptype, 'params': params})
                else:
                    properties.append({'name': str(p.Name), 'type': ptype})
            types.append({
                'name': raw,
                'kind': self.kind_of(td, extends),
                'genericParams': self.type_params.get(ti, []),
                'extends': extends or None,
                'interfaces': [self.coded_type(i, ctx) for i in impls.get(ti, [])],
                'attributes': sorted(set(attrs.get(ti, []))),
                'methods': methods,
                'properties': properties,
                'indexers': indexers,
            })
        return types


def build(path: str) -> dict:
    with open(path, 'rb') as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    dumper = Dumper(path)
    types = dumper.dump()
    if not types:
        raise DumpError('metadata declares no types')
    module = dumper.md.Module.rows[0]
    asm = dumper.md.Assembly.rows[0] if dumper.md.Assembly else None
    return {
        'format': FORMAT,
        'formatVersion': FORMAT_VERSION,
        'generator': 'roon-internal-api/tools/dump_broker_api.py',
        'assembly': {
            'name': str(asm.Name) if asm else os.path.basename(path),
            'file': os.path.basename(path),
            'mvid': str(module.Mvid),
            'sha256': digest,
        },
        'declaredOnly': True,
        'types': types,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dll', required=True, help='path to Roon.Broker.Api.dll')
    ap.add_argument('--out', help='output JSON path (default: stdout)')
    args = ap.parse_args()
    try:
        out = build(args.dll)
    except ImportError:
        print('dump_broker_api: dnfile is required (pip install dnfile)', file=sys.stderr)
        return 2
    except (OSError, DumpError) as exc:
        print(f'dump_broker_api: {args.dll}: {exc}', file=sys.stderr)
        return 2
    text = json.dumps(out, indent=1, ensure_ascii=False) + '\n'
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            fh.write(text)
        methods = sum(len(t['methods']) for t in out['types'])
        props = sum(len(t['properties']) for t in out['types'])
        print(f'dumped {len(out["types"])} types, {methods} methods, {props} properties -> {args.out}', file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
