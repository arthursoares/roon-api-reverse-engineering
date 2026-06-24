/**
 * roon-web SPA.
 * Phase 4: live controls — transport, volume, favorite, play (confirm), power
 * (confirm) — on top of zones/devices/search/library.
 */
interface Zone {
  oid: string; name: string; state?: number; stateLabel: string; seekPosition?: number;
  isPlayAllowed?: boolean; isPauseAllowed?: boolean; isNextAllowed?: boolean; isPreviousAllowed?: boolean;
  nowPlaying: { lines: string[]; length?: number } | null;
}
interface Device {
  oid: string; name: string; zoneOid?: string; volume?: number; minVolume?: number; maxVolume?: number;
  supportsVolume?: boolean; isMuted?: boolean; supportsStandby?: boolean; isStandby?: boolean;
}
interface Snapshot { zones: Zone[]; devices: Device[] }
interface AlbumRow { oid: string; title: string; artist?: string }
interface TrackRow { oid: string; title: string }
interface NamedRow { oid: string; name: string }
interface SearchResults { albums: AlbumRow[]; artists: NamedRow[]; playlists: NamedRow[]; genres: NamedRow[]; tracks: TrackRow[]; loaded: number }
interface ApiMethod { name: string; signature: string; params: { name: string; type: string }[]; response: boolean }
interface ApiService { name: string; methods: ApiMethod[] }
interface Catalog { source: string; serviceCount: number; methodCount: number; services: ApiService[] }

const ZONE_PLAYING = 0; // Sooloos.Broker.Api.ZoneState.Playing

const statusEl = document.getElementById('status')!;
const appEl = document.getElementById('app')!;
const $ = (id: string) => document.getElementById(id)!;

let ws: WebSocket;
let lastZones: Zone[] = [];
let targetZone = '';
let catalog: Catalog | null = null;

const esc = (s: string) => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtTime = (s?: number) => (s == null ? '' : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`);
const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = text; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const PANELS = [
  { id: 'play', label: 'Now Playing', icon: '♪' },
  { id: 'search', label: 'Search', icon: '⌕' },
  { id: 'library', label: 'Library', icon: '▤' },
  { id: 'devices', label: 'Devices', icon: '◫' },
  { id: 'api', label: 'API Explorer', icon: '{}' },
];

function showPanel(id: string) {
  appEl.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${id}`));
  appEl.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', (n as HTMLElement).dataset.panel === id));
}

function skeleton() {
  appEl.innerHTML = `
    <aside class="sidebar">
      <nav>${PANELS.map((p) => `<button class="nav-item" data-panel="${p.id}">
        <span class="nav-icon">${p.icon}</span> ${p.label}</button>`).join('')}</nav>
    </aside>
    <div class="content">
      <section id="panel-play" class="panel active">
        <div class="controlbar card">
          <label>Play target zone:</label>
          <select id="target"></select>
          <span class="muted">audio + power actions ask for confirmation first</span>
        </div>
        <h2 class="sec">Zones <span id="zones-count" class="count">0</span></h2>
        <div id="zones" class="grid zones-grid"></div>
      </section>
      <section id="panel-search" class="panel">
        <h2 class="sec">Search</h2>
        <input id="q" type="search" placeholder="Search your library (e.g. Clube, Saudades, Gilberto)…" autocomplete="off" />
        <div id="search-results"></div>
      </section>
      <section id="panel-library" class="panel">
        <h2 class="sec">Library <span id="lib-count" class="count">0</span></h2>
        <div id="library"><p class="muted">loading…</p></div>
      </section>
      <section id="panel-devices" class="panel">
        <h2 class="sec">Devices <span id="dev-count" class="count">0</span></h2>
        <div id="devices" class="grid devices-grid"></div>
      </section>
      <section id="panel-api" class="panel">
        <h2 class="sec">API Explorer <span id="api-count" class="count">0</span></h2>
        <input id="api-filter" type="search" placeholder="Filter methods (e.g. Favorite, Volume, Library::Play)…" autocomplete="off" />
        <p class="muted small">Read-only reference of the full reverse-engineered surface from <code>catalog.authoritative.json</code>. Accessors hidden.</p>
        <div id="api-list"><p class="muted">loading…</p></div>
      </section>
    </div>`;

  appEl.querySelectorAll('.nav-item').forEach((n) =>
    n.addEventListener('click', () => showPanel((n as HTMLElement).dataset.panel!)));

  const q = $('q') as HTMLInputElement;
  let timer: number | undefined;
  q.addEventListener('input', () => {
    const v = q.value; clearTimeout(timer);
    timer = window.setTimeout(() => { if (v.trim().length >= 2) send({ t: 'search', q: v }); }, 250);
  });
  ($('target') as HTMLSelectElement).addEventListener('change', (e) => { targetZone = (e.target as HTMLSelectElement).value; });

  const af = $('api-filter') as HTMLInputElement;
  let aTimer: number | undefined;
  af.addEventListener('input', () => { clearTimeout(aTimer); aTimer = window.setTimeout(() => renderCatalog(af.value), 120); });

  // delegated clicks for all data-action controls
  appEl.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!el) return;
    const a = el.dataset.action!;
    if (a === 'transport') send({ t: 'transport', zone: el.dataset.zone, action: el.dataset.tact });
    else if (a === 'favorite') { send({ t: 'favorite', oid: el.dataset.oid, on: el.dataset.on !== '1' }); }
    else if (a === 'play') {
      const zone = targetZone || lastZones[0]?.oid;
      const zname = lastZones.find((z) => z.oid === zone)?.name ?? 'zone';
      if (!zone) return toast('no zone available', 'err');
      if (confirm(`Play "${el.dataset.title}" on ${zname}? (this will produce audio)`))
        send({ t: 'play', zone, kind: el.dataset.kind, oid: el.dataset.oid, confirm: true });
    } else if (a === 'power') {
      const on = el.dataset.on !== '1'; // toggling
      if (confirm(`${on ? 'Power on' : 'Standby'} "${el.dataset.name}"?`))
        send({ t: 'power', endpoint: el.dataset.endpoint, on, confirm: true });
    }
  });
  // volume sliders
  appEl.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.classList.contains('vol')) send({ t: 'volume', endpoint: el.dataset.endpoint, value: Number(el.value) });
  });
}

function transportBtns(z: Zone): string {
  const b = (act: string, label: string, on = true) =>
    `<button class="tbtn" data-action="transport" data-zone="${z.oid}" data-tact="${act}" ${on ? '' : 'disabled'}>${label}</button>`;
  return `<div class="tbar">
    ${b('Previous', '⏮', z.isPreviousAllowed !== false)}
    ${b('PlayPause', z.state === ZONE_PLAYING ? '⏸' : '▶')}
    ${b('Next', '⏭', z.isNextAllowed !== false)}
  </div>`;
}

function renderZones(z: Zone[]) {
  lastZones = z;
  $('zones-count').textContent = String(z.length);
  $('zones').innerHTML = z.map((zone) => {
    const playing = zone.state === ZONE_PLAYING;
    const np = zone.nowPlaying?.lines?.length
      ? zone.nowPlaying.lines.map((l, i) => `<div class="np-line ${i === 0 ? 'np-title' : ''}">${esc(l)}</div>`).join('')
      : `<div class="np-line muted">${esc(zone.stateLabel)}</div>`;
    return `<div class="zone card">
      <div class="zone-head"><span class="zone-name">${esc(zone.name)}</span>
        <span class="badge ${playing ? 'badge-play' : ''}">${esc(zone.stateLabel)}</span></div>
      <div class="np">${np}</div>
      ${zone.seekPosition != null ? `<div class="seek muted">${fmtTime(zone.seekPosition)}</div>` : ''}
      ${transportBtns(zone)}
    </div>`;
  }).join('') || '<p class="muted">no zones</p>';

  // populate target-zone selector (preserve selection)
  const sel = $('target') as HTMLSelectElement;
  const cur = sel.value;
  sel.innerHTML = z.map((zone) => `<option value="${zone.oid}">${esc(zone.name)}</option>`).join('');
  const hifi = z.find((zone) => /hifi/i.test(zone.name));
  sel.value = cur && z.some((zone) => zone.oid === cur) ? cur : (hifi?.oid ?? z[0]?.oid ?? '');
  targetZone = sel.value;
}

function renderDevices(d: Device[]) {
  $('dev-count').textContent = String(d.length);
  $('devices').innerHTML = d.map((x) => `<div class="device card">
    <div class="dev-head"><span>${esc(x.name)}</span>
      ${x.supportsStandby ? `<button class="tbtn" data-action="power" data-endpoint="${x.oid}" data-name="${esc(x.name)}" data-on="${x.isStandby ? '0' : '1'}">${x.isStandby ? 'Power on' : 'Standby'}</button>` : ''}
    </div>
    ${x.supportsVolume && x.volume != null
      ? `<div class="vol-row"><input class="vol" type="range" data-endpoint="${x.oid}"
           min="${x.minVolume ?? 0}" max="${x.maxVolume ?? 100}" value="${Math.round(x.volume)}" />
           <span class="vol-val">${Math.round(x.volume)}</span></div>`
      : '<div class="muted small">no volume control</div>'}
  </div>`).join('');
}

function albumGrid(albums: AlbumRow[], emptyMsg: string): string {
  if (!albums.length) return `<p class="muted">${emptyMsg}</p>`;
  return `<div class="grid albums-grid">${albums.map((a) => `<div class="album">
    <div class="album-title">${esc(a.title)}</div>
    ${a.artist ? `<div class="album-artist muted">${esc(a.artist)}</div>` : ''}
    <div class="album-actions">
      <button class="tbtn" data-action="play" data-kind="album" data-oid="${a.oid}" data-title="${esc(a.title)}">▶ Play</button>
      <button class="tbtn" data-action="favorite" data-oid="${a.oid}" data-on="0">♥</button>
    </div></div>`).join('')}</div>`;
}

function namedList(rows: NamedRow[]): string {
  return `<div class="chips">${rows.map((r) => `<span class="chip">${esc(r.name)}</span>`).join('')}</div>`;
}

function renderSearch(r: SearchResults) {
  const total = r.albums.length + r.artists.length + r.playlists.length + r.genres.length + r.tracks.length;
  const sec = (label: string, n: number, body: string) =>
    n ? `<div class="sub-head">${label} <span class="count">${n}</span></div>${body}` : '';
  $('search-results').innerHTML = `<div class="card">
    ${total === 0 ? '<p class="muted">no matches in the loaded working set</p>' : ''}
    ${sec('Albums', r.albums.length, albumGrid(r.albums, ''))}
    ${sec('Artists', r.artists.length, namedList(r.artists))}
    ${sec('Tracks', r.tracks.length, `<table><tbody>${r.tracks.map((t) => `<tr>
        <td>${esc(t.title)}</td>
        <td class="num"><button class="tbtn" data-action="play" data-kind="track" data-oid="${t.oid}" data-title="${esc(t.title)}">▶</button></td>
      </tr>`).join('')}</tbody></table>`)}
    ${sec('Playlists', r.playlists.length, namedList(r.playlists))}
    ${sec('Genres', r.genres.length, namedList(r.genres))}
    <p class="muted small note">Searches the ${r.loaded.toLocaleString()} objects the core has loaded
      this session — not the full catalog. Full-library search needs the reactive query
      subsystem (see <code>docs/plans/2026-06-12-search-root-cause.md</code>).</p>
  </div>`;
}

function connectWs() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { statusEl.textContent = 'connected'; statusEl.className = 'status ok'; };
  ws.onclose = () => { statusEl.textContent = 'reconnecting…'; statusEl.className = 'status err'; setTimeout(connectWs, 1500); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'snapshot') { renderZones(msg.zones); renderDevices(msg.devices); }
    else if (msg.t === 'searchResults') renderSearch(msg as SearchResults);
    else if (msg.t === 'result') toast(`${msg.action}: ${msg.ok ? 'ok' : 'failed'}${msg.status ? ` (${msg.status})` : ''}`, msg.ok ? 'ok' : 'err');
    else if (msg.t === 'error') toast(msg.msg, 'err');
  };
}

function methodRow(m: ApiMethod): string {
  const args = m.params.map((p) => `<span class="arg"><span class="arg-type">${esc(p.type)}</span> ${esc(p.name)}</span>`).join(', ');
  return `<div class="api-method">
    <span class="api-mname">${esc(m.name)}</span><span class="api-paren">(</span>${args}<span class="api-paren">)</span>
    ${m.response ? '<span class="api-ret">→ result</span>' : ''}
  </div>`;
}

function renderCatalog(filter = '') {
  if (!catalog) return;
  const f = filter.trim().toLowerCase();
  const services = catalog.services
    .map((s) => {
      const methods = f
        ? s.methods.filter((m) => s.name.toLowerCase().includes(f) || m.signature.toLowerCase().includes(f))
        : s.methods;
      return { name: s.name, methods };
    })
    .filter((s) => s.methods.length > 0);

  const shownMethods = services.reduce((n, s) => n + s.methods.length, 0);
  $('api-count').textContent = f ? `${shownMethods}/${catalog.methodCount}` : String(catalog.methodCount);

  if (!services.length) { $('api-list').innerHTML = '<p class="muted">no methods match</p>'; return; }
  // When filtering, open matching services so results are visible immediately.
  $('api-list').innerHTML = services.map((s) => `<details class="api-svc" ${f ? 'open' : ''}>
    <summary><span class="api-sname">${esc(s.name)}</span><span class="count">${s.methods.length}</span></summary>
    <div class="api-methods">${s.methods.map(methodRow).join('')}</div>
  </details>`).join('');
}

async function loadCatalog() {
  try {
    catalog = await (await fetch('/api/catalog')).json();
    renderCatalog('');
  } catch { $('api-list').innerHTML = '<p class="muted">failed to load catalog</p>'; }
}

async function loadLibrary() {
  try {
    const lib = await (await fetch('/api/library')).json();
    $('lib-count').textContent = String(lib.albums.length);
    $('library').innerHTML = albumGrid(lib.albums, 'no albums loaded');
  } catch { /* ignore */ }
}

skeleton();
connectWs();
loadLibrary();
loadCatalog();
