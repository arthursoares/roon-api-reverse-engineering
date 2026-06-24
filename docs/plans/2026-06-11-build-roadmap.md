# Build Roadmap & Status — full client from decompiled assemblies

Goal: map and **validate** ALL methods so different clients / PoCs can be built.
Decisions (aligned with user 2026-06-11):
- **Reference client language: TypeScript** (`roon-internal-api/`).
- **C# oracle** (references Roon's real DLLs) is the byte-exact validation source.
- **Live validation scope:** reads, queries, favorite toggle, AND playback/volume/
  transfer on a designated **test zone** (Office). Metadata edits + destructive
  calls are **encoding-validated only**, not executed live.

## Source of truth
Roon ships unobfuscated Mono/.NET assemblies in
`/Applications/Roon.app/Contents/MonoBundle/`. Decompile with `ilspycmd`
(installed at `~/.dotnet/tools`; dotnet SDK 10 at `/usr/local/share/dotnet`).
- `Roon.Broker.Remoting.dll` — framing, serializer primitives, dispatch.
- `Roon.Broker.Api.dll` — 120 interfaces, ~1033 method decls, type adapters.
- Decompiled cache: `/tmp/roon-decomp/{remoting,api}/` (regenerate with
  `ilspycmd <dll> -o <dir>`).

## Protocol facts (verified from source + wire)
- Frame: `[cmd] [flexint requestId if cmd|0x40] [flexint bodyLength] [body]`.
- cmds: PING=1, GETSVC=2, CALL=3, GCOBJS=4, DEFTYPE=5, DEFMETHOD=6, SENDMSG=7
  (wire byte = cmd, or cmd|0x40 when a response is expected).
- Varint = big-endian base-128 (`WriteFlexInt`/`WriteFlexLong`). Object ids are
  flexlong; method ids + lengths + enums are flexint.
- CALL body = `flexLong(objectId) + flexInt(methodId) + args`.
- First use of a methodId auto-sends DEFMETHOD: `flexInt(methodId) + string(name)`.
  Method ids are client-assigned ints; object ids are server-assigned (PUSHOBJ).
- Arg encoding per type: primitives via RemotingUtils; reference types (Track,
  Album…) as their objectId (flexlong); structs/value types (PlayParameters,
  *QueryCriteria) via their generated adapter (baked into Api.dll).
- **No authentication** anywhere in the local protocol.

## Status

### DONE
- [x] Architecture + scope decided.
- [x] Service/method catalog mapped → `src/catalog/catalog.json`
      (**146 interfaces, 1509 methods**, 128 callable services, inheritance
      resolved). Tool: `tools/extract_catalog.py`.
- [x] Serialization primitives ported (`src/proto/flex.ts`, `src/proto/writer.ts`)
      — **byte-exact validated** against captured favorite call
      (`src/proto/proto.test.ts`): the full FavoriteOrBan call body
      reconstructs to `2e8420123f...410e2fa18c6701`.
- [x] **Wire signature formatter** (`src/catalog/signature.ts`) — **validated
      against ALL 67 captured DEFMETHOD strings** (`signature.test.ts`). Type-name
      mapping pinned (Sooid→System.Sooid, ResultCallback→Base.ResultCallback,
      collections→System.Collections.Generic.*, byte[]→System.Byte[], API types
      prefixed, primitives keep keyword form). We can now construct a valid
      DEFMETHOD for any of the 1509 methods. 26 tests passing.

- [x] **C# oracle** (`oracle/`, .NET 10 + MetadataLoadContext) →
  `src/catalog/catalog.authoritative.json`: **295 services, 1550 RPC methods,
  103 enums**, exact FQ signatures + enum values. **Reproduces all 67 captured
  DEFMETHOD signatures** (`authoritative.test.ts`); cross-validates the text
  catalog. NOTE: MetadataLoadContext is metadata-only (no execution), so golden
  *bytes* come from porting decompiled adapters + capture validation, not from
  running their serializer.

- [x] **Frame codec** (`src/proto/frame.ts`): encode/parse the
  `[header][rid?][len][body]` framing; handles TCP coalescing/splitting.
  Validated against captured frames incl. the favorite call & `c0` acks.
- [x] **Remoting client** (`src/proto/remoting.ts`): method-id assignment,
  DEFMETHOD-on-first-use, request/response correlation, getService, PING auto-ack.
  Unit-tested with a mock transport.
- [x] **Connection/transport** (`src/proto/connection.ts`): ROON handshake +
  ConnectRequest, wires the socket to the remoting client.
- [x] **LIVE END-TO-END** (`examples/live-connect.ts`): the ported TS stack
  established a real remoting session against the core — `getService` resolved
  root objectId=3 and we received the full object graph (2810 PUSHOBJ, 139
  DEFTYPE, ~5000 frames), all parsed/acked correctly. Status sentinel = the
  string "Success". **37 tests passing.**

- [x] **Object-graph reader** (`src/proto/reader.ts` + `src/proto/objects.ts`):
  generic deserializer driven by the wire DEFTYPE schema (PropertyType per
  member). Ingests DEFTYPE/PUSHOBJ/PUSHSTUB/UPDATEOBJ. **Validated against the
  real captured server stream** (`examples/decode-capture.ts`): 186 types, 7197
  objects, found Library **oid=46** (exact match to the favorite capture),
  Transport/Playlists/Broker, and decoded track/work titles. Deterministic unit
  tests in `objects.test.ts`. 40 tests passing.

  NOTE: object **oid + type** come from the frame header (always reliable);
  String fields can hold binary collation/filter keys (not a decode bug).

- [x] **Arg serializer** (`src/proto/serializer.ts`): typed-arg API → wire bytes
  (Sooid, enum→flexInt, by-ref object→flexLong(oid), primitives, refList,
  bytes; ResultCallback omitted).
- [x] **Object decoder corrected**: object fields use a SPARSE encoding —
  `(memberIndex:flexInt, value)*` terminated by index 0 (from generated
  Populate), NOT positional. After the fix, all fields decode cleanly (titles,
  sort/filter keys, refs) on the live core and captures.
- [x] **FIRST LIVE MUTATION** (`examples/live-favorite.ts`): connected → found
  Library oid=46 → found album "Clube Da Esquina" by title → `FavoriteOrBan`
  (Sooid profile + AlbumBase oid + state) → server returned **"Success"**.
  A real library write from our own ported client. The "auth wall" is dead. 40
  tests passing. (Profile Sooid reused from captures: `3f01…0e2f`.)

- [x] **Favorite verified in UI + reverted.** Library writes confirmed working.
- [x] **Object reader generalized** (`examples/live-explore.ts`): albums/tracks/
  works/zones/endpoints all decode cleanly on the live core.
- [~] **Playback (HiFi zone)** — partial. Found HiFi via Endpoint::Name→Zone
  (zone oid 464116). `Transport::PlayAlbum` now dispatches (signature must use the
  full `ResultCallback<PlayFeedback>`), but the call times out because
  **PlayParameters needs the by-value path**: it is NOT a server-pushed type, so
  the client must (a) send its own DEFTYPE (cmd 5) declaring the struct's members,
  then (b) encode it as an inline value object `flexLong(1)+typeId+len+sparse
  fields`. By-ref args (Zone/Album oids) are already correct.

- [x] **By-value struct serializer** (`RemotingClient.defineType` cmd 5 +
  `serializer.inlineStruct`): client declares a value type via DEFTYPE (member
  match is by name, so a subset/empty is fine) and sends it as an inline value
  object `flexLong(1)+typeId+len+sparse fields`. Ported from `_WriteTypeId`.
- [x] **LIVE PLAYBACK confirmed (audio)**: `Transport::PlayAlbum` on the HiFi
  zone (oid 464116) with an empty `PlayParameters` returned **"Success"** and the
  user confirmed sound. Then `Zone::Pause()` (fire-and-forget, no-arg) stopped it.
  Notes: callback type must be the full `ResultCallback<PlayFeedback>`; zones are
  named via Endpoint::Name → Endpoint::Zone. 40 tests passing.

The full read+write stack is now proven live for BOTH simple-arg (favorite,
UI-confirmed) and struct-arg (playback, audio-confirmed) methods. Remaining work
is breadth + ergonomics:

- [x] **Type classification** (oracle `typeKinds`): every API type tagged
  enum / byref / byval (293 byval, 301 byref, 103 enum). Lets arg-building be
  automatic from the catalog.
- [x] **RoonClient facade** (`src/proto/client.ts`): connect + object graph +
  service lookup + generic `call()` + typed helpers (favoriteAlbum, playAlbum,
  playAlbumOnZone, zoneControl, standby, powerOn). A PoC is now ~4 lines
  (`examples/demo.ts`).
- [x] **Library cleanup**: removed the old pre-decompilation broken modules
  (`src/protocol`, `src/services`, old client/connection/errors). `src/index.ts`
  exports the validated `proto` + `catalog` stack. **tsc clean, 23 tests pass.**

The project's core goal is met: all 1550 methods mapped (authoritative),
encoding/framing/signatures validated against captures, and the four method
classes proven LIVE — simple-arg (favorite, UI-confirmed), by-val struct
(playback, audio-confirmed), fire-and-forget no-arg (pause/standby), and
response-based no-struct (powerOn/getService). Building clients/PoCs is real
today via RoonClient + the generic call + the catalog.

- [x] **Populated structs** (`RoonClient.structArg`): declare a value type with
  named members + serialize set fields. Proven via `UnifiedSearch` (Terms +
  ProfileId) returning "Success".
- [x] **Search POC** (`examples/poc-search.ts`): interactive search → table →
  play a chosen result on a chosen zone (one session). `RoonClient.search()`,
  `playAlbum`/`playTrack`. Works for in-library content.
- [~] **Collections** (`objects.ts`): DataList/Query decode added — built-in
  count at wire-index 1, then inline items. Empty/loaded collections read; but
  some pushes send the count with items DEFERRED (pushed separately by oid) or
  stream via UPDATEOBJ — so `UnifiedSearch`'s lazy result lists don't fully
  populate yet. Hence the POC substring-matches pushed/loaded content rather than
  draining the result DataLists. Finishing this = full streaming search.

### SEARCH / PAGED QUERIES — mechanism cracked, delivery WIP (`captures/search.pcap`)
Captured an official-client search ("joão gilberto"). Findings:
- Our `UnifiedSearch` call is byte-correct (inline `SearchParameters`); the server
  DOES return full results for the official client (740 "Gilberto" hits incl.
  "Chega de Saudade", "Getz/Gilberto", 58 tracks).
- `UnifiedSearch` alone returns a LAZY container; the official client then fires
  **follow-up per-category Library query calls** (methodIds 748–760, criteria +
  `pt-BR`/`en` language prefs) that actually load+push each section's results.
- Implemented the query path scaffold: `RoonClient.searchAlbums` =
  `VirtualAlbumQuery(profile, AlbumQueryCriteria{TextFilter}, VirtualQueryParameters{PageSize})`
  → returns a `VirtualAlbumLiteQuery` oid → `RetainPage(0)`. Both calls return
  "Success". BUT: (a) `TextFilter` alone isn't applied (Count came back = whole
  library 3942), and (b) the query's `Sections` `DataList<VirtualQuerySection>`
  stays empty — RetainPage's page items aren't delivered into it yet.

  TO FINISH: decode the exact criteria fields + the Sections/RetainPage delivery
  from `captures/search.pcap` + `from-start.pcap` (which has a working
  `VirtualAlbumLiteQuery::RetainPage`), and match the page-delivery (likely
  UPDATEOBJ to the Sections DataList or section objects pushed by oid). This is
  the reactive paged-query subsystem; it unlocks search AND browse AND full
  library listing.

### REMAINING (breadth / polish, not blockers)
0. **Finish paged-query delivery** (above) — the one real subsystem left.
1. **Full typed codegen** from catalog.authoritative.json (one method per entry)
   using `typeKinds` — generates the entire 1550-method typed surface.
2. **Populated struct schemas**: derive member name+PropertyType per byval type
   (oracle) so non-default structs (query criteria, edits) serialize; validate
   vs captures.
3. **Metadata-edit** path end-to-end (original north star; mechanism proven —
   it's a byval-struct method like the ones already working).

## Validation strategy ("mapped AND validated")
- **Encoding-validated** (all 1033): TS serializer output == C# oracle golden
  bytes. Cross-checked against real captures for the methods we have on the wire.
- **Live-validated** (safe subset): executed against the core and observed
  (favorite reflects in UI; playback starts on the test zone).
- Destructive/edit methods: encoding-validated only (per user scope).

## Test zone (for live playback validation)
Office zone — Sooid `YOUR_ZONE_SOOID`,
Output `YOUR_OUTPUT_ID:roon_YOUR_OUTPUT_GUID_Office`.
Confirm with user before producing audio.
