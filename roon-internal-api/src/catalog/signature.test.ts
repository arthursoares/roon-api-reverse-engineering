import * as fs from 'fs';
import * as path from 'path';
import { formatMethodSignature, formatType } from './signature';

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const captured: string[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'captured_signatures.json'), 'utf8')
);

// Build the set of every signature our formatter can produce from the catalog.
function allFormatted(): Set<string> {
  const set = new Set<string>();
  for (const [service, methods] of Object.entries<any[]>(catalog.services)) {
    // strip generic params from interface name (e.g. "VirtualQuery<...>")
    const svc = service.replace(/<.*>$/, '');
    for (const m of methods) {
      set.add(formatMethodSignature(svc, m.name, m.params));
    }
  }
  return set;
}

describe('wire signature formatter (validated vs captured ground truth)', () => {
  test('formatType handles the captured type vocabulary', () => {
    expect(formatType('Sooid')).toBe('System.Sooid');
    expect(formatType('Sooid?')).toBe('System.Sooid?');
    expect(formatType('TrackBase')).toBe('Sooloos.Broker.Api.TrackBase');
    expect(formatType('ResultCallback')).toBe('Base.ResultCallback');
    expect(formatType('byte[]')).toBe('System.Byte[]');
    expect(formatType('string')).toBe('string');
    expect(formatType('bool')).toBe('bool');
    expect(formatType('IEnumerable<TrackBase>')).toBe(
      'System.Collections.Generic.IEnumerable<Sooloos.Broker.Api.TrackBase>'
    );
    expect(formatType('ResultCallback<Query<AlbumLite>>')).toBe(
      'Base.ResultCallback<Sooloos.Broker.Api.Query<Sooloos.Broker.Api.AlbumLite>>'
    );
    expect(formatType('IList<string>')).toBe('System.Collections.Generic.IList<string>');
  });

  test('every captured DEFMETHOD signature is reproducible from the catalog', () => {
    const formatted = allFormatted();
    const missing = captured.filter((s) => !formatted.has(s));
    if (missing.length) {
      // Surface the first few mismatches for debugging.
      console.error('Unreproduced signatures:\n' + missing.slice(0, 10).join('\n'));
    }
    expect(missing).toEqual([]);
  });

  test('FavoriteOrBan(track) formats exactly', () => {
    expect(
      formatMethodSignature('Library', 'FavoriteOrBan', [
        { type: 'Sooid', name: 'profileid' },
        { type: 'TrackBase', name: 'track' },
        { type: 'FavoriteBanState', name: 'state' },
        { type: 'ResultCallback', name: 'cb_result' },
      ])
    ).toBe(
      'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)'
    );
  });
});
