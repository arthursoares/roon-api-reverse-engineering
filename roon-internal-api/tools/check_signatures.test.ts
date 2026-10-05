import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classify,
  compare,
  compareCatalog,
  DumpModel,
  extractInventory,
  InputError,
  inventoryProblems,
  loadCatalog,
  main,
  parseDump,
  parseMember,
  parseTypeRef,
  runFixture,
  substitute,
} from './check_signatures';

const FIXTURES = path.join(__dirname, 'fixtures/signature-drift');
const fixtureDirs = fs.readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

function run(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function dumpOf(types: object[]): string {
  return JSON.stringify({ format: 'roon-broker-api-dump', formatVersion: 1, types });
}

describe('name parsing', () => {
  test('member names split on the last top-level space before ::', () => {
    expect(parseMember('System.Collections.Generic.IList<string> Sooloos.Broker.Api.EditList<string>::AddValues')).toEqual({
      type: 'System.Collections.Generic.IList<string>',
      decl: 'Sooloos.Broker.Api.EditList<string>',
      name: 'AddValues',
    });
    expect(parseMember('int Sooloos.Broker.Api.X<A, B>::Y')?.decl).toBe('Sooloos.Broker.Api.X<A, B>');
  });

  test('closed generics key on their open definition', () => {
    expect(parseTypeRef('Sooloos.Broker.Api.VirtualQuery<Sooloos.Broker.Api.AlbumLite, Sooloos.Broker.Api.AlbumBase>')).toEqual({
      key: 'Sooloos.Broker.Api.VirtualQuery`2',
      args: ['Sooloos.Broker.Api.AlbumLite', 'Sooloos.Broker.Api.AlbumBase'],
    });
  });

  test('substitution replaces whole unqualified identifiers only', () => {
    expect(substitute('System.Collections.Generic.IList<T>', { T: 'string' })).toBe('System.Collections.Generic.IList<string>');
    expect(substitute('Sooloos.Broker.Api.T', { T: 'string' })).toBe('Sooloos.Broker.Api.T');
    expect(substitute('System.Action<K, V>', { K: 'V', V: 'K' })).toBe('System.Action<V, K>');
  });

  test('classify recognises the three wire-name shapes and nothing else', () => {
    expect(classify('Sooloos.Broker.Api.Zone::Pause()')?.kind).toBe('method');
    expect(classify('int Sooloos.Broker.Api.VirtualQueryParameters::PageSize')?.kind).toBe('member');
    expect(classify('Sooloos.Broker.Api.EditList<string>')?.kind).toBe('type');
    expect(classify('Sooloos.Broker.Api.')).toBeUndefined();
    expect(classify('::Title')).toBeUndefined();
    expect(classify('unknown member Foo for Sooloos.Broker.Api.X')).toBeUndefined();
  });
});

describe('SDK inventory', () => {
  const inv = extractInventory();
  const has = (kind: string, name: string, owner?: string) => inv.names.some((w) => w.kind === kind && w.name === name && w.owner === owner);

  test('is plausibly complete', () => {
    expect(inventoryProblems(inv)).toEqual([]);
  });

  test('expands literal-union parameters at formatMethodSignature call sites', () => {
    for (const m of ['Pause', 'Play', 'PlayPause', 'Stop', 'Next', 'Previous']) {
      expect(has('method', `Sooloos.Broker.Api.Zone::${m}()`)).toBe(true);
    }
  });

  test('evaluates RoonClient.call sites through the shipping formatter', () => {
    expect(has('method', 'Sooloos.Broker.Api.VirtualAlbumLiteQuery::RetainPage(int, Base.ResultCallback)')).toBe(true);
    expect(inv.names.find((w) => w.name === 'Sooloos.Broker.Api.Library::Edit(Sooloos.Broker.Api.LibraryEdit, Base.ResultCallback)')?.origins).toContain('RoonClient.call');
  });

  test('resolves same-file consts inside template literals', () => {
    expect(has('member', 'System.Collections.Generic.IList<string> Sooloos.Broker.Api.EditList<string>::AddValues')).toBe(true);
    expect(has('member', 'int? Sooloos.Broker.Api.EditOptionalVal<int>::EditValue')).toBe(true);
  });

  test('records structArg short member names against their struct type', () => {
    expect(has('shortMember', 'UiLanguage', 'Sooloos.Broker.Api.AlbumQueryCriteria')).toBe(true);
    expect(has('shortMember', 'PageSize', 'Sooloos.Broker.Api.VirtualQueryParameters')).toBe(true);
  });

  test('lists runtime-only call sites as unresolved instead of skipping them', () => {
    const where = inv.unresolved.map((u) => `${u.site.file}:${u.reason}`);
    expect(where).toContain('src/proto/client.ts:runtime-only service, method, params');
    expect(where.some((w) => w.startsWith('src/proto/structs.ts:runtime-only struct type'))).toBe(true);
  });

  test('agrees with the committed catalog', () => {
    expect(compareCatalog(inv, loadCatalog())).toEqual([]);
  });
});

describe('fixtures', () => {
  test('all four fixtures are present', () => {
    expect(fixtureDirs).toEqual(['generics', 'inherited-retainpage', 'missing-member', 'namespace-rename']);
  });

  test.each(fixtureDirs)('%s matches its expected drift set and bindings', (name) => {
    expect(runFixture(path.join(FIXTURES, name)).errors).toEqual([]);
  });

  test('a same-named method on an unrelated type is a hint, never a match', () => {
    const r = runFixture(path.join(FIXTURES, 'inherited-retainpage'));
    const d = r.comparison.drift.find((x) => x.name.startsWith('Sooloos.Broker.Api.Library::RetainPage'));
    expect(d?.code).toBe('METHOD_DRIFT');
    expect(d?.hints.join('\n')).toMatch(/unrelated type\(s\) VirtualQuery`2, Pager/);
  });

  test('the namespace alias applies to metadata only', () => {
    const r = runFixture(path.join(FIXTURES, 'missing-member'));
    const d = r.comparison.drift.find((x) => x.name.startsWith('Roon.Broker.Api.Library::UnifiedSearch'));
    expect(d?.hints.join('\n')).toMatch(/#15/);
  });

  test('drift diagnostics name the closest DLL candidate', () => {
    const r = runFixture(path.join(FIXTURES, 'missing-member'));
    const d = r.comparison.drift.find((x) => x.name.includes('GetDailyPicks'));
    expect(d?.candidates).toEqual([
      'Sooloos.Broker.Api.Library::GetDailyPicks(System.Sooid, Sooloos.Broker.Api.DailyPicksParameters, Base.ResultCallback<Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.DailyPicksBox>>)',
    ]);
  });
});

describe('input validation', () => {
  test.each([
    ['PE bytes', Buffer.from('MZ\x90\x00', 'latin1'), /PE\/DLL/],
    ['truncated JSON', '{"format"', /not JSON/],
    ['foreign format', '{"format":"other","formatVersion":1,"types":[]}', /not a roon-broker-api-dump/],
    ['future version', '{"format":"roon-broker-api-dump","formatVersion":2,"types":[]}', /formatVersion/],
    ['foreign assembly', dumpOf([{ name: 'Contoso.Gear' }]), /foreign input/],
    ['malformed members', dumpOf([{ name: 'Sooloos.Broker.Api.X', properties: [{ name: 'A' }] }]), /malformed/],
  ])('%s is an INPUT_ERROR', (_label, input, re) => {
    expect(() => parseDump(input, 'test')).toThrow(InputError);
    expect(() => parseDump(input, 'test')).toThrow(re);
  });

  test('derived generic arity mismatches are not silently bound', () => {
    const model = new DumpModel(parseDump(dumpOf([
      { name: 'Sooloos.Broker.Api.Base`1', kind: 'interface', genericParams: ['T'], methods: [{ name: 'M', params: ['T'] }] },
      { name: 'Sooloos.Broker.Api.Derived', kind: 'interface', interfaces: ['Sooloos.Broker.Api.Base<int, int>'] },
    ]), 'test'));
    const inv = { names: [{ kind: 'method' as const, name: 'Sooloos.Broker.Api.Derived::M(int)', origins: ['test'], sites: [{ file: 't', line: 1 }] }], unresolved: [], files: [] };
    expect(compare(inv, model).drift.map((d) => d.code)).toEqual(['METHOD_DRIFT']);
  });
});

describe('CLI', () => {
  test('--catalog-only passes on the shipping SDK', () => {
    const r = run(['--catalog-only']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ok: 0 catalog mismatches/);
  });

  test('--self-test passes', () => {
    const r = run(['--self-test']);
    expect(r.out).not.toMatch(/FAIL/);
    expect(r.code).toBe(0);
  });

  test('usage errors exit 2', () => {
    expect(run([]).code).toBe(2);
    expect(run(['--dump']).code).toBe(2);
    expect(run(['--bogus']).code).toBe(2);
    expect(run(['--self-test', '--catalog-only']).code).toBe(2);
  });

  test('unreadable or invalid dumps exit 2 with INPUT_ERROR', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigdrift-'));
    try {
      const bad = path.join(tmp, 'bad.json');
      fs.writeFileSync(bad, 'MZ not a dump');
      for (const p of [path.join(tmp, 'missing.json'), bad]) {
        const r = run(['--dump', p]);
        expect(r.code).toBe(2);
        expect(r.err).toMatch(/^INPUT_ERROR /m);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a dump with drift exits 1 with named diagnostics', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigdrift-'));
    try {
      // An otherwise empty broker assembly: every SDK name drifts.
      const p = path.join(tmp, 'dump.json');
      fs.writeFileSync(p, dumpOf([{ name: 'Roon.Broker.Api.Library', kind: 'interface' }]));
      const r = run(['--dump', p]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/NAMESPACE_ALIAS/);
      expect(r.err).toMatch(/^METHOD_DRIFT src\/generated\/api\.ts:\d+/m);
      expect(r.err).toMatch(/^MEMBER_DRIFT src\/generated\/struct-schemas\.ts:\d+/m);
      expect(r.err).toMatch(/^TYPE_DRIFT /m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
