/**
 * Maps browser requests to the RoonClient. Phase 3: search + library.
 * Phase 4 adds transport/volume/favorite/play/standby.
 */
import { RoonClient, generated } from '../../roon-internal-api/src/index';
import { RoonObject } from '../../roon-internal-api/src/proto/objects';

function title(o: RoonObject): string | undefined {
  for (const [k, v] of Object.entries(o.fields)) if ((k.endsWith('::Title') || k.endsWith('::Name')) && typeof v === 'string') return v;
  return undefined;
}
// Roon links display names as `[[id|Name]]`; strip to plain text.
function cleanLinks(s: string): string {
  return s.replace(/\[\[\d+\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
}
function artistOf(o: RoonObject): string | undefined {
  for (const suf of ['::LocalizedPerformedBy', '::PerformedBy', '::Subtitle']) {
    for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suf) && typeof v === 'string' && v) return cleanLinks(v);
  }
  return undefined;
}

export interface AlbumRow { oid: string; title: string; artist?: string }
export interface TrackRow { oid: string; title: string }
export interface ArtistRow { oid: string; name: string }
export interface NamedRow { oid: string; name: string }
export interface SearchResult {
  albums: AlbumRow[]; artists: NamedRow[]; playlists: NamedRow[]; genres: NamedRow[]; tracks: TrackRow[];
  /** total objects in the working set we searched (for the UI scope note). */
  loaded: number;
}

/**
 * Search the objects the core has already pushed this session (the lazy/cached
 * working set). NOTE: this is NOT a full-catalog search — server-side search
 * needs the reactive event subsystem the core never enables for our connection.
 * See docs/plans/2026-06-12-search-root-cause.md.
 */
export async function search(roon: RoonClient, q: string): Promise<SearchResult> {
  const needle = q.trim().toLowerCase();
  const empty: SearchResult = { albums: [], artists: [], playlists: [], genres: [], tracks: [], loaded: 0 };
  if (!needle) return empty;

  const named = (types: string[]): NamedRow[] => {
    const seen = new Set<string>();
    const out: NamedRow[] = [];
    for (const t of types) {
      for (const o of roon.graph.findByType(t)) {
        const n = title(o);
        const key = o.oid.toString();
        if (n && n.toLowerCase().includes(needle) && !seen.has(key)) {
          seen.add(key);
          out.push({ oid: key, name: cleanLinks(n) });
        }
      }
    }
    return out.slice(0, 50);
  };

  const albumSeen = new Set<string>();
  const albums: AlbumRow[] = [];
  for (const o of [...roon.graph.findByType('AlbumLite'), ...roon.graph.findByType('Album')]) {
    const t = title(o);
    const key = o.oid.toString();
    if (t && t.toLowerCase().includes(needle) && !albumSeen.has(key)) {
      albumSeen.add(key);
      albums.push({ oid: key, title: t, artist: artistOf(o) });
    }
  }

  return {
    albums,
    artists: named(['PerformerLite', 'Performer']),
    playlists: named(['Playlist']),
    genres: named(['GenreLite', 'BrowserGenre']),
    tracks: named(['TrackLite']).map((r) => ({ oid: r.oid, title: r.name })),
    loaded: roon.graph.objects.size,
  };
}

export function library(roon: RoonClient): { albums: AlbumRow[]; artists: ArtistRow[] } {
  const seen = new Set<string>();
  const albums: AlbumRow[] = [];
  for (const o of [...roon.graph.findByType('AlbumLite'), ...roon.graph.findByType('Album')]) {
    const t = title(o);
    const key = o.oid.toString();
    if (t && !seen.has(key)) {
      seen.add(key);
      albums.push({ oid: key, title: t, artist: artistOf(o) });
    }
  }
  const aseen = new Set<string>();
  const artists: ArtistRow[] = [];
  for (const o of roon.graph.findByType('PerformerLite')) {
    const n = title(o);
    const key = o.oid.toString();
    if (n && !aseen.has(key)) {
      aseen.add(key);
      artists.push({ oid: key, name: n });
    }
  }
  return { albums, artists };
}

// --- controls (Phase 4) ---

const TRANSPORT = new Set(['Pause', 'Play', 'PlayPause', 'Next', 'Previous', 'Stop']);

/** Zone transport: Pause/Play/PlayPause/Next/Previous/Stop (fire-and-forget). */
export function transport(roon: RoonClient, zoneOid: string, action: string): { ok: boolean } {
  if (!TRANSPORT.has(action)) throw new Error(`unsupported transport action: ${action}`);
  roon.zoneControl(BigInt(zoneOid), action as any);
  return { ok: true };
}

/** Endpoint volume (Endpoint::SetVolumeDouble). */
export async function setVolume(roon: RoonClient, endpointOid: string, value: number): Promise<{ ok: boolean; status: string }> {
  const ep = new generated.EndpointApi(roon, BigInt(endpointOid));
  const r = await ep.setVolumeDouble(value);
  return { ok: r.success, status: r.status };
}

/** Favorite/unfavorite an album (reversible). FavoriteBanState: None=0, Favorite=1. */
export async function favorite(roon: RoonClient, oid: string, on: boolean): Promise<{ ok: boolean; status: string }> {
  const r = await roon.favoriteAlbum(BigInt(oid), on);
  return { ok: r.success, status: r.status };
}

/** Play an album or track on a zone (CONFIRM-gated at the caller; produces audio). */
export async function play(roon: RoonClient, zoneOid: string, kind: 'album' | 'track', oid: string): Promise<{ ok: boolean; status: string }> {
  const r = kind === 'track' ? await roon.playTrack(BigInt(zoneOid), BigInt(oid)) : await roon.playAlbum(BigInt(zoneOid), BigInt(oid));
  return { ok: r.success, status: r.status };
}

/** Standby (power off) / ConvenienceSwitch (power on) an endpoint (CONFIRM-gated). */
export async function power(roon: RoonClient, endpointOid: string, on: boolean): Promise<{ ok: boolean; status?: string }> {
  if (on) {
    const r = await roon.powerOn(BigInt(endpointOid));
    return { ok: r.success, status: r.status };
  }
  roon.standby(BigInt(endpointOid));
  return { ok: true };
}
