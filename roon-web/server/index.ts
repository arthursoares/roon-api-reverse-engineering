/**
 * roon-web backend: http + ws server that serves the SPA and bridges browser
 * requests to the live RoonClient. Phase 1 = scaffold + connect + /api/health.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { getRoon } from './roon';
import { snapshot } from './state';
import { search, library, transport, setVolume, favorite, play, power } from './bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // dist/
const PUBLIC = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4321);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// --- API catalog (Phase 5): slim view of the authoritative method catalog ---
const CATALOG_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'roon-internal-api',
  'src',
  'catalog',
  'catalog.authoritative.json',
);
const ACCESSOR = /^(get_|set_|add_|remove_)/; // hide property/event accessors
let catalogCache: unknown = null;
function loadCatalog(): unknown {
  if (catalogCache) return catalogCache;
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const services = (raw.services as any[])
    .map((s) => ({
      name: s.name,
      methods: (s.methods as any[])
        .filter((m) => !ACCESSOR.test(m.name))
        .map((m) => ({
          name: m.name,
          signature: m.signature,
          params: (m.params as any[]).map((p) => ({ name: p.name, type: p.type })),
          response: !!m.expectsResponse,
        })),
    }))
    .filter((s) => s.methods.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  catalogCache = {
    source: raw.source,
    serviceCount: services.length,
    methodCount: services.reduce((n, s) => n + s.methods.length, 0),
    services,
  };
  return catalogCache;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/health') {
    try {
      const roon = await getRoon();
      return json(res, 200, {
        connected: true,
        objects: roon.graph.objects.size,
        types: roon.graph.types.size,
        library: roon.graph.findByType('Library')[0]?.oid.toString() ?? null,
      });
    } catch (e) {
      return json(res, 503, { connected: false, error: (e as Error).message });
    }
  }

  if (url === '/api/snapshot') {
    try {
      const roon = await getRoon();
      return json(res, 200, snapshot(roon));
    } catch (e) {
      return json(res, 503, { error: (e as Error).message });
    }
  }

  if (url === '/api/library') {
    try {
      const roon = await getRoon();
      return json(res, 200, library(roon));
    } catch (e) {
      return json(res, 503, { error: (e as Error).message });
    }
  }

  if (url === '/api/catalog') {
    try {
      return json(res, 200, loadCatalog());
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  }

  // static files from public/
  const rel = url === '/' ? '/index.html' : url;
  const fp = path.join(PUBLIC, path.normalize(rel));
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

const wss = new WebSocketServer({ server });

async function pushSnapshot(target?: WebSocket) {
  let payload: string;
  try {
    const roon = await getRoon();
    payload = JSON.stringify({ t: 'snapshot', ...snapshot(roon) });
  } catch (e) {
    payload = JSON.stringify({ t: 'error', msg: (e as Error).message });
  }
  const clients = target ? [target] : [...wss.clients];
  for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'hello' }));
  pushSnapshot(ws);
  ws.on('message', async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      const roon = await getRoon();
      if (msg.t === 'snapshot') {
        pushSnapshot(ws);
      } else if (msg.t === 'search') {
        const results = await search(roon, String(msg.q ?? ''));
        ws.send(JSON.stringify({ t: 'searchResults', q: msg.q, ...results }));
      } else if (msg.t === 'transport') {
        const r = transport(roon, String(msg.zone), String(msg.action));
        ws.send(JSON.stringify({ t: 'result', action: 'transport', ...r }));
        setTimeout(() => pushSnapshot(), 400);
      } else if (msg.t === 'volume') {
        const r = await setVolume(roon, String(msg.endpoint), Number(msg.value));
        ws.send(JSON.stringify({ t: 'result', action: 'volume', ...r }));
        setTimeout(() => pushSnapshot(), 400);
      } else if (msg.t === 'favorite') {
        const r = await favorite(roon, String(msg.oid), !!msg.on);
        ws.send(JSON.stringify({ t: 'result', action: 'favorite', oid: msg.oid, on: msg.on, ...r }));
      } else if (msg.t === 'play') {
        // Audio-producing: require explicit confirmation from the UI.
        if (!msg.confirm) throw new Error('play requires confirm:true');
        const r = await play(roon, String(msg.zone), msg.kind === 'track' ? 'track' : 'album', String(msg.oid));
        ws.send(JSON.stringify({ t: 'result', action: 'play', ...r }));
        setTimeout(() => pushSnapshot(), 600);
      } else if (msg.t === 'power') {
        // Device power on/off: require explicit confirmation from the UI.
        if (!msg.confirm) throw new Error('power requires confirm:true');
        const r = await power(roon, String(msg.endpoint), !!msg.on);
        ws.send(JSON.stringify({ t: 'result', action: 'power', ...r }));
        setTimeout(() => pushSnapshot(), 600);
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', msg: (e as Error).message }));
    }
  });
});

// Periodic state refresh so the UI reflects now-playing/zone changes.
setInterval(() => {
  if (wss.clients.size) pushSnapshot();
}, 2000);

server.listen(PORT, () => {
  console.log(`roon-web listening on http://localhost:${PORT}`);
});

// Connect to the core on boot (read-only); log status.
getRoon()
  .then((r) => console.log(`connected to core — ${r.graph.objects.size} objects loaded`))
  .catch((e) => console.error('roon connect failed (will retry on request):', (e as Error).message));
