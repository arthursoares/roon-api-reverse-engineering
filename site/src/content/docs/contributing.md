---
title: Contributing
description: Capture traffic, find your own Core's details, run the checks, validate methods, and help with the open bits.
sidebar:
  order: 1
---

This is a hobby reverse-engineering experiment, and help is very welcome — especially from
other Roon users who've wanted a more capable API for years. Most of what's left isn't deep
protocol work; it's **breadth and validation**: confirming generated methods against a real
Core, and cracking the one subsystem that's still fuzzy (streaming-catalog search).

## How it was built

Worth being upfront: most of this project — the protocol decoding, the TypeScript port, the
codegen, and these docs — was done by pair-programming with Claude (Anthropic's Claude Code).
If you contribute, you're welcome to work the same way; a lot of the grind (decoding
captures, generating wrappers) suits an agent well.

## Project layout

```
roon-api-reverse-engineering/
├─ roon-internal-api/        the TypeScript client (the main artifact)
│  ├─ src/proto/             protocol: frame, flex, writer/reader, remoting,
│  │                         connection, serializer, objects, client (facade)
│  ├─ src/catalog/           signatures + the extracted method catalog (~1550 methods)
│  ├─ src/generated/         generated typed API (one class per service)
│  ├─ oracle/                C# tool: reads the Roon DLLs → the catalog JSON
│  ├─ tools/                 codegen + capture-decoding scripts
│  └─ examples/              runnable PoCs (one per thing that works)
├─ roon-web/                 a small web client poking at the API
├─ docs/plans/              the raw working notes / decision log
└─ site/                     this site (Astro + Starlight)
```

## Prerequisites

- A **Roon Core** on your network and the **desktop client** (for capturing).
- **Node 18+** (developed on 22).
- `tcpdump` + `tshark` (Wireshark CLI) for captures.
- For regenerating the catalog: a **.NET SDK** and `ilspycmd` (decompile + the oracle).

## Finding your Core details

You need two values (neither is a secret — there's no local auth):

1. **Host** — the Core's IP (Roon → Settings → About).
2. **Server broker id** — a 16-byte id sent in the handshake. Capture the desktop client
   connecting and read it off the first `ROON`-prefixed packet:

   ```bash
   sudo tcpdump -i any -w handshake.pcap host <CORE_IP> and port 9332
   # start/restart the Roon desktop client, then Ctrl-C
   tshark -r handshake.pcap -Y tcp.payload -T fields -e tcp.payload | head
   ```

   The bytes right after the `ROON 0104` magic are the server broker id, then the client
   broker id. (`docs/CAPTURE_GUIDE.md` has the longer walk-through.)

Put both in env vars and pass them to `RoonClient` — keep your own details out of committed
code.

## Capturing traffic

The whole thing is capture-driven. To work out a new operation, capture the official client
doing it **from connection start** (so the type/method declarations are present):

```bash
# pick the right interface for your network
sudo tcpdump -i en0 -w captures/<operation>.pcap host <CORE_IP> and port 9332
# perform the operation once in the desktop client, then Ctrl-C
```

Reassemble and decode streams with the helpers in `tools/` (`parse_stream.py`,
`decode_query.py`) — see each script's header. Diffing your capture against a known one is
the fastest way to isolate the new bytes.

## Running the checks

```bash
cd roon-internal-api
npx tsc --noEmit   # keep it clean
npx jest           # keep it green
```

The site:

```bash
cd site
npm install
npm run dev        # local preview
npm run build      # what CI deploys
```

## Validating a method

A generated method only really counts once its encoding is confirmed — *compiling proves
nothing*. Any one of these is good enough:

1. **Capture match** — your bytes equal the official client's bytes for the same call (the
   strongest evidence; see the `*.test.ts` files for the pattern).
2. **Oracle golden** — the C# reflection tool agrees on the signature / struct shape.
3. **Round-trip** — encode an argument, re-read it through `ObjectGraph`, get the same value
   back (handy for structs you don't have a capture for).
4. **Live effect** — the Core visibly does the thing (UI change, audio, read-back).

Add a test under the relevant `src/**/*.test.ts` when you confirm something.

## Safety

:::danger[Don't auto-run destructive calls]
Never fire `Destroy*`, delete, or `ClearMetadataEdits`-style methods at a real library
without intent and a backup. Encoding-validate them instead.
:::

- Gate anything that **produces audio** behind an explicit step; use a **zone you don't mind
  interrupting**.
- Favorites and metadata edits are reversible — still test on disposable data.
- The protocol is **private and unversioned** — expect it to change between Roon releases.

## Best place to start: search

The one genuinely open piece. The `UnifiedSearch` call looks byte-correct and the Core *does*
return full results — but it delivers them lazily: after `UnifiedSearch`, the official client
fires a batch of per-section follow-up `Library` queries (method ids around 748–760), and
result objects stream into collections.

To push it forward:

1. Capture the official client **typing in the search box**, from connection start.
2. Identify the per-section follow-up methods by signature + their argument structs.
3. Replicate those calls after `UnifiedSearch`, then **harvest** the pushed
   `AlbumLite`/`TrackLite`/`PerformerLite` objects from the graph (they do land — a captured
   search pushed well over a hundred album objects).

`RoonClient.search()` already harvests pushed objects by substring; it just needs those
follow-up calls to trigger the push. The deeper decode notes are in
`docs/plans/2026-06-11-MASTER-PLAN.md` (the search section) — worth reading before diving in.

## License & ethics

MIT-licensed. This is an **independent interoperability and learning** experiment. It is
**not affiliated with, endorsed by, or supported by Roon Labs**. It only works against a Core
you control, speaking a protocol Roon's own client already uses on your own network — there's
no circumvention of authentication (there doesn't appear to be any locally) and no access to
anyone else's system. Please keep contributions in that spirit: your own Core, your own data,
interoperability only.
