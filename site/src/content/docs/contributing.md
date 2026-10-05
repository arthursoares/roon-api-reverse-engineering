---
title: Contributing
description: Capture traffic, find your own Core's details, run the checks, validate methods, and help with the open bits.
sidebar:
  order: 1
---

This is a hobby reverse-engineering experiment, and help is very welcome — especially from
other Roon users who've wanted a more capable API for years. Most of what's left isn't deep
protocol work; it's **breadth and validation**: confirming generated methods against a real
Core, broader streaming-provider behavior, and compatibility across Core versions.

## How it was built

Worth being upfront: most of this project — the protocol decoding, the TypeScript port, the
codegen, and these docs — was done by pair-programming with Claude (Anthropic's Claude Code).
If you contribute, you're welcome to work the same way; a lot of the grind (decoding
captures, generating wrappers) suits an agent well.

Recent maintenance and adversarial review were performed with Codex. See
[Releases](/releases/) for contributor credit and the evidence behind v0.1.1.

## Project layout

```
roon-api-reverse-engineering/
├─ roon-internal-api/        the TypeScript client (the main artifact)
│  ├─ src/proto/             protocol: frame, flex, writer/reader, remoting,
│  │                         connection, serializer, objects, client (facade)
│  ├─ src/catalog/           signatures + the extracted method catalog (~1550 methods)
│  ├─ src/generated/         generated typed API (one class per service)
│  ├─ oracle/                C# tool: reads the Roon DLLs → the catalog JSON
│  ├─ tools/                 codegen, DLL dump + signature-drift check
│  └─ examples/              runnable PoCs (one per thing that works)
├─ roon-web/                 a small web client poking at the API
├─ docs/plans/              the raw working notes / decision log
└─ site/                     this site (Astro + Starlight)
```

## Prerequisites

- A **Roon Core** on your network and the **desktop client** (for capturing).
- **Node 22** for the repository checks (the version used by CI); the SDK requires Node 18+.
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

   SOOD discovery can also return the Core's `unique_id` as a textual UUID. Its wire
   bytes use .NET GUID order: reverse bytes in the first three UUID groups, leaving
   the last two groups unchanged. For example, the synthetic UUID
   `01234567-89ab-cdef-0123-456789abcdef` becomes
   `67452301ab89efcd0123456789abcdef`. Simply removing hyphens gives the wrong order.

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
npm ci
npm run lint
npm test -- --runInBand
npm run build
npx ts-node tools/gen_client.ts
git diff --exit-code -- src/generated/api.ts src/generated/struct-schemas.ts docs/reflist-audit.md
npm run check:signatures -- --catalog-only
npm run check:signatures -- --self-test
```

The web client:

```bash
cd roon-web
npm ci
npm run typecheck
npm test
npm run build
```

Run each block from the repository root. CI also requires every generated output
to remain tracked, so deleting an output cannot be hidden by regeneration.

The site (release history is generated from the root `CHANGELOG.md`):

```bash
cd site
npm install
npm run dev        # local preview
npm run build      # what CI deploys
```

## After a Roon update

The Core silently drops a DEFMETHOD signature or struct member name it doesn't know, so
check the SDK's wire names against the newly installed DLL (offline; needs Python and
`pip install dnfile`):

```bash
cd roon-internal-api
python3 tools/dump_broker_api.py --dll /Applications/Roon.app/Contents/MonoBundle/Roon.Broker.Api.dll --out /tmp/broker-api.json
npm run check:signatures -- --dump /tmp/broker-api.json
```

Each `METHOD_DRIFT`, `MEMBER_DRIFT` or `TYPE_DRIFT` names the source line that sends the
stale name and the closest names the DLL declares; the report also lists what the committed
catalog and the new DLL disagree on. Only the evidenced `Roon.Broker.Api.` →
`Sooloos.Broker.Api.` metadata alias is normalized (the wire keeps `Sooloos.*`). Inherited
and generic bindings are modeled explicitly; a same-named method on an unrelated type is
never accepted. Runtime-only names are listed as `UNRESOLVED`. A clean name check does not
validate a serializer — see below. Don't commit the dump.

## Validating a method

A generated method needs evidence beyond compilation. State the tier and Core version
your verification covers:

1. **Capture match** — your bytes equal the official client's bytes for the same call (the
   strongest evidence; see the `*.test.ts` files for the pattern).
2. **Receiver/oracle evidence** — inspect the actual codec as well as reflection metadata.
   A CLR return type alone does not establish its wire representation.
3. **Byte/behavior regression** — test exact framing, following-field alignment, retries,
   and the real receiver's cache lifecycle. Self-consistent round trips alone can miss a
   shared incorrect assumption.
4. **Live read or effect** — a real Core returns the expected data or visibly performs an
   authorized action. A read-only success does not validate a mutation path.

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

## Useful next contributions

UnifiedSearch now follows the callback's result memberships, including cached and
concurrent results. Broader provider/version coverage remains useful, but collecting
global graph objects or substring matches is not the current search implementation.

A runtime watcher that flags a Core version never checked for drift (the follow-up to
[#16](https://github.com/arthursoares/roon-api-reverse-engineering/issues/16)) is still open.
Most generated methods still need independent byte-level and live validation.

Keep the historical capture and investigation notes under `docs/plans/` intact; they
record the earlier hypotheses and do not replace current interoperability evidence.

## License & ethics

MIT-licensed. This is an **independent interoperability and learning** experiment. It is
**not affiliated with, endorsed by, or supported by Roon Labs**. It only works against a Core
you control, speaking a protocol Roon's own client already uses on your own network — there's
no circumvention of authentication (there doesn't appear to be any locally) and no access to
anyone else's system. Please keep contributions in that spirit: your own Core, your own data,
interoperability only.
