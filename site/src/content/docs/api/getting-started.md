---
title: Getting started
description: Point the experiment at your own Roon Core and read the live object graph.
sidebar:
  order: 1
---

`roon-internal-api` is the TypeScript side of this experiment. It lives in the
[`roon-internal-api/`](https://github.com/arthursoares/roon-api-reverse-engineering/tree/main/roon-internal-api)
directory of the repo. It's **not published to npm** — use it from a clone. Expect rough
edges; this is a proof-of-concept.

## Install

```bash
git clone https://github.com/arthursoares/roon-api-reverse-engineering
cd roon-api-reverse-engineering/roon-internal-api
npm install
npx tsc --noEmit   # type-check
npx jest           # the small test suite
```

## What you need from your own Core

Two values identify *your* Core. They aren't secrets (there's no auth here), but they're
specific to your install, so supply your own rather than copying mine:

| Value | What it is | How to find it |
|-------|-----------|----------------|
| `host` | Core IP / hostname | Roon → Settings → About, or your router |
| `serverBrokerId` | 16-byte Core id (hex) | read it off a capture of the handshake — see [Contributing](/contributing/#finding-your-core-details) |

:::tip
Keep them in env vars, not in code. The examples read `ROON_HOST`; do the same for the
broker id so you don't accidentally commit your own details.
:::

## Connect and read

The `RoonClient` facade is the front door. A minimal, read-only program (placeholders below
— swap in your own values):

```ts
import { RoonClient } from 'roon-internal-api'; // or '../src/proto/client' in-repo

const roon = new RoonClient({
  host: process.env.ROON_HOST!,                         // e.g. '192.168.1.50'
  serverBrokerId: Buffer.from(process.env.ROON_BROKER_ID!, 'hex'), // 16-byte hex
});

await roon.connect();

console.log('Library oid:', roon.serviceOid('Library').toString());
console.log('Zone oid:', roon.zoneByName('Living Room')?.toString());

const album = roon.findByTitle('AlbumLite', 'Kind of Blue');
console.log(album ? `found, oid=${album.oid}` : 'not loaded');

roon.close();
```

Run it with `npx ts-node examples/demo.ts` (set `ROON_HOST`).

On `connect()` the client does the handshake, resolves the root service, and starts
ingesting the streaming object graph — so zones, devices, now-playing, and loaded library
content are queryable via the helpers below. How reliable this is beyond my own setup, I
genuinely don't know.

## Core helpers on `RoonClient`

| Method | Purpose |
|--------|---------|
| `connect()` / `close()` | open / close the session |
| `serviceOid(name)` | object id of a singleton service (`'Library'`, `'Transport'`…) |
| `zoneByName(name)` / `endpointByName(name)` | resolve a zone / endpoint oid |
| `findByTitle(type, title)` | find a loaded object by title (e.g. `'AlbumLite'`) |
| `titleOf(obj)` | best-effort display title of an object |
| `call(service, method, params, args, oid?)` | low-level escape hatch to any method |
| `structArg(typeName, fields)` | build a by-val struct argument |

For doing things — favorites, playback, edits, search — see [Recipes](/api/recipes/). For
the full generated method surface, see [the generated API](/api/recipes/#the-full-generated-api).

:::caution[This drives your real system]
Anything that produces audio or edits your library is a real action against your live Core.
The examples target a single test zone and gate audio behind explicit calls. Don't auto-run
destructive methods (`Destroy*`, `ClearMetadataEdits`, deletes) — see the
[contributing guide](/contributing/#safety).
:::
