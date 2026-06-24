# WEB CLIENT PLAN — showcase the Roon internal API

Build a web client that showcases the capabilities of `roon-internal-api`
(the validated TS client; see `docs/plans/2026-06-11-MASTER-PLAN.md`). Decisions
(user, 2026-06-12): **vanilla TS SPA** served by a thin Node backend; **full live
control** (browse/search/play/pause/next/prev/volume/favorite/standby), with audio
targeting the **HiFi** test zone behind a confirm step.

## Definition of done
A `roon-web/` app that, run with one command, connects to the live core and serves
a browser UI that demonstrates, end to end and live:
1. **Zones + now-playing** — list zones, show what's playing (title/album/state),
   with transport controls (play/pause/next/previous) and a volume slider.
2. **Search** — type a term, get album/track results, click to play on a chosen
   zone or favorite.
3. **Library browse** — loaded albums/artists/tracks grid.
4. **Devices** — endpoints with standby/power toggle + volume.
5. **API explorer** — browse the full 1550-method catalog (services → methods →
   signatures) to show the breadth of the surface.
Plus a connection/status indicator. tsc clean; no destructive calls; audio + standby
gated by a confirm dialog defaulting to HiFi.

## Architecture
```
roon-web/
  package.json            (esbuild, ws, express or node:http; depends on ../roon-internal-api)
  build.mjs               (esbuild bundle public/app.ts -> public/app.js)
  server/
    index.ts              node http + ws; serves public/, holds ONE RoonClient
    bridge.ts             maps WS/REST messages <-> RoonClient + generated API
    state.ts              snapshots zones/devices/now-playing from the object graph
  public/
    index.html
    app.ts                SPA (panels below); talks to backend over WS + REST
    style.css             clean modern CSS
```
Backend holds a single persistent `RoonClient` (host YOUR_CORE_IP:9332, server
broker id `YOUR_SERVER_BROKER_ID`, root guid `bcd36e84…709b`). It keeps
the object graph live and pushes state to connected browsers over WS.

## WS/REST protocol (simple JSON)
- REST: `GET /api/catalog` (serves catalog.authoritative.json slimmed to
  services→methods→signatures), `GET /api/health`.
- WS client→server: `{t:'snapshot'}`, `{t:'search', q}`, `{t:'play', zone, kind:'album'|'track', oid}`,
  `{t:'transport', zone, action:'PlayPause'|'Pause'|'Play'|'Next'|'Previous'}`,
  `{t:'volume', endpoint, value}`, `{t:'favorite', kind, oid, on}`,
  `{t:'standby', endpoint, on}`.
- WS server→client: `{t:'snapshot', zones, devices}`, `{t:'searchResults', albums, tracks}`,
  `{t:'result', ok, status}`, `{t:'error', msg}`. Re-push `snapshot` after mutating
  commands (and on a short poll/refresh) so the UI updates.

## Capability → API mapping (all proven live)
- zones/devices/now-playing: `roon.graph.findByType('Zone'|'Endpoint')`; resolve
  zone↔endpoint by Endpoint::Name→Zone ref; now-playing via Zone.NowPlaying ref
  (title/album strings; State; SeekPosition).
- search: `roon.searchAlbums(q)` (+ harvest TrackLite for tracks).
- play: `roon.playAlbum(zoneOid, albumOid)` / `roon.playTrack(zoneOid, trackOid)`.
- transport: `roon.zoneControl(zoneOid, 'Pause'|'Play'|'PlayPause'|'Next'|'Previous')`.
- volume: generated `EndpointApi(roon, endpointOid).setVolumeDouble(value)`
  (Endpoint::SetVolumeDouble(double, cb)). Read range via Endpoint Min/MaxVolumeDouble.
- favorite: `roon.favoriteAlbum(oid, on)` (+ a track/performer variant via FavoriteOrBan).
- standby/power: `roon.standby(endpointOid)` / `roon.powerOn(endpointOid)`.
- catalog: read `roon-internal-api/src/catalog/catalog.authoritative.json`.

## Safety
- Audio (play) and standby/power: backend requires an explicit `confirm:true` flag;
  the UI shows a confirm dialog; default audio zone = HiFi. Favorite is reversible
  (no confirm). NEVER expose Destroy/delete/metadata-clear or other destructive
  methods in the UI.

## Phases (ordered, autonomous-executable)
1. ✅ **Scaffold + backend connect** (DONE 2026-06-12): `roon-web/` package, esbuild build, node http+ws
   server serving `public/`, one RoonClient that connects on boot. `GET /api/health`
   returns connected + object counts. Commit.
2. ✅ **State + snapshot** (DONE 2026-06-12): `state.ts` builds a zones+devices+now-playing snapshot from
   the graph; WS pushes it on connect and on a short interval. Frontend renders a
   read-only Zones panel + Devices panel. Commit.
3. ✅ **Search + library** (DONE 2026-06-12): search box → `searchAlbums` → results table; loaded-albums
   grid. Frontend panels. Commit.
4. ✅ **Controls (live)** (DONE 2026-06-12): transport buttons, volume slider, favorite toggle, play (with
   confirm), standby/power (with confirm) — wired through the bridge to RoonClient.
   Re-push snapshot after each. Commit.
5. ✅ **API explorer** (DONE 2026-06-12): `/api/catalog` (slimmed authoritative catalog, accessors
   hidden — 152 services / 1550 methods) + a collapsible frontend panel listing services→methods→
   signatures with a live substring filter (auto-expands matches). Commit.
6. ✅ **Polish** (DONE 2026-06-12): sidebar nav with switchable panels (Now Playing / Search /
   Library / Devices / API Explorer), modern dark CSS + fade transitions, responsive collapse,
   error/result toasts, WS auto-reconnect. Now-playing art SKIPPED — `broker:///image/{id}` needs a
   binary-protocol image fetch the client doesn't implement; not trivially fetchable per the STRETCH
   guidance. Commit.

**All 6 phases complete.** Run with `cd roon-web && npm install && npm run dev`.

## Run
`cd roon-web && npm install && npm run dev` → builds the SPA and starts the server;
open the printed `http://localhost:PORT`. Document the exact command in roon-web/README.

## Notes / gotchas (carry over from MASTER-PLAN)
- Bash cwd resets between calls — always `cd` first; use the Write tool for files.
- Object ids are session-scoped — the backend holds one connection so ids stay valid.
- Stable profile Sooid value: `3f01162027273a55d64bbf4a85f335410e2f`.
- HiFi zone resolved by Endpoint::Name → Endpoint::Zone ref (oids session-specific).
- Album art (`broker:///image/...`) is not plain HTTP — treat as a stretch; the
  showcase works on text/metadata without it.
- Keep `roon-web` tsc-clean; don't run destructive or unconfirmed-audio live calls.
- Don't break the existing `roon-internal-api` (depend on it, import from its src).
