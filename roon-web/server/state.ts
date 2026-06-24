/**
 * Build a UI snapshot (zones + devices + now-playing) from the live object graph.
 * Defensive field reads (Roon objects vary); refine field names against live data.
 */
import { RoonClient } from '../../roon-internal-api/src/index';
import { RoonObject, isRef } from '../../roon-internal-api/src/proto/objects';

function str(o: RoonObject, suffix: string): string | undefined {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && typeof v === 'string') return v;
  return undefined;
}
function bigintRef(o: RoonObject, suffix: string): bigint | undefined {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && isRef(v)) return (v as any).$ref;
  return undefined;
}
function numField(o: RoonObject, suffix: string): number | undefined {
  for (const [k, v] of Object.entries(o.fields)) {
    if (k.endsWith(suffix)) {
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return Number(v);
    }
  }
  return undefined;
}
function boolField(o: RoonObject, suffix: string): boolean | undefined {
  for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && typeof v === 'boolean') return v;
  return undefined;
}

// Best-effort now-playing display from the NowPlaying object (+ its Track if any).
function nowPlaying(roon: RoonClient, npo: RoonObject) {
  const lines = [
    str(npo, '::OneLine') ?? str(npo, '::Line1'),
    str(npo, '::TwoLine') ?? str(npo, '::Line2'),
    str(npo, '::ThreeLine') ?? str(npo, '::Line3'),
  ].filter(Boolean) as string[];

  // Some now-playing objects carry a Track ref or direct Title/Subtitle.
  if (!lines.length) {
    const title = str(npo, '::Title');
    if (title) lines.push(title);
    const sub = str(npo, '::Subtitle') ?? str(npo, '::Artist');
    if (sub) lines.push(sub);
  }
  // follow a Track / OneBox ref if present
  const trackRef = bigintRef(npo, '::Track') ?? bigintRef(npo, '::NowPlayingTrack');
  if (!lines.length && trackRef !== undefined) {
    const t = roon.graph.getObject(trackRef);
    if (t) {
      const tt = str(t, '::Title');
      if (tt) lines.push(tt);
    }
  }
  const length = numField(npo, '::Length') ?? numField(npo, '::LengthSeconds');
  return { lines, length };
}

// Sooloos.Broker.Api.ZoneState (from catalog.authoritative.json).
const STATE_LABEL: Record<number, string> = { 0: 'playing', 1: 'loading', 2: 'paused', 3: 'stopped' };

export interface Snapshot {
  zones: Array<{
    oid: string; name: string; state: number | undefined; stateLabel: string;
    seekPosition: number | undefined; isPlayAllowed?: boolean; isPauseAllowed?: boolean;
    isNextAllowed?: boolean; isPreviousAllowed?: boolean;
    nowPlaying: { lines: string[]; length?: number } | null;
  }>;
  devices: Array<{
    oid: string; name: string; zoneOid?: string;
    volume?: number; minVolume?: number; maxVolume?: number; supportsVolume?: boolean;
    isMuted?: boolean; supportsStandby?: boolean; isStandby?: boolean;
  }>;
}

export function snapshot(roon: RoonClient): Snapshot {
  const endpoints = roon.graph.findByType('Endpoint');

  // endpoint name -> zone oid (zones are named via their endpoints)
  const zoneName = new Map<string, string>();
  for (const e of endpoints) {
    const nm = str(e, '::Name');
    const z = bigintRef(e, '::Zone');
    if (nm && z !== undefined) zoneName.set(z.toString(), nm);
  }

  const zones = roon.graph.findByType('Zone').map((z) => {
    const np = bigintRef(z, '::NowPlaying');
    const npo = np !== undefined ? roon.graph.getObject(np) : undefined;
    const state = numField(z, '::State');
    return {
      oid: z.oid.toString(),
      name: zoneName.get(z.oid.toString()) ?? 'Zone',
      state,
      stateLabel: state !== undefined ? (STATE_LABEL[state] ?? `state ${state}`) : '—',
      seekPosition: numField(z, '::SeekPosition'),
      isPlayAllowed: boolField(z, '::IsPlayAllowed'),
      isPauseAllowed: boolField(z, '::IsPauseAllowed'),
      isNextAllowed: boolField(z, '::IsNextAllowed'),
      isPreviousAllowed: boolField(z, '::IsPreviousAllowed'),
      nowPlaying: npo ? nowPlaying(roon, npo) : null,
    };
  });

  const devices = endpoints
    .map((e) => ({
      oid: e.oid.toString(),
      name: str(e, '::Name') ?? '',
      zoneOid: bigintRef(e, '::Zone')?.toString(),
      volume: numField(e, '::VolumeDouble'),
      minVolume: numField(e, '::MinVolumeDouble'),
      maxVolume: numField(e, '::MaxVolumeDouble'),
      supportsVolume: boolField(e, '::SupportsVolumeDouble'),
      isMuted: boolField(e, '::IsMuted'),
      supportsStandby: boolField(e, '::SupportsStandby'),
      isStandby: boolField(e, '::IsStandby'),
    }))
    .filter((d) => d.name);

  return { zones, devices };
}
