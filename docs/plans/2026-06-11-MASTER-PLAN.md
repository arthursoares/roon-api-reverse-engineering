# MASTER PLAN — Build the complete Roon internal API (all 1550 methods)

**This is the authoritative resume + execution doc.** Read this first in any new
session. Goal: a fully-typed TypeScript client exposing ALL Roon internal API
methods, validated, so any client/PoC can be built. The protocol is fully
understood; what remains is breadth (codegen) + one subsystem (paged queries).

---

## 0. TL;DR for a fresh session

- The project is **solved**: there is no auth. Protocol = `Sooloos.Broker.Remoting`,
  reverse-engineered from Roon's **unobfuscated** Mono assemblies in
  `/Applications/Roon.app/Contents/MonoBundle/`.
- A faithful, test-covered TS port exists in `roon-internal-api/src/proto/` +
  `src/catalog/`. Use `RoonClient` (`src/proto/client.ts`).
- **Proven LIVE** against the user's core (YOUR_CORE_IP:9332): read object graph,
  favorite album (UI-confirmed), PlayAlbum (audio-confirmed), Zone pause, Endpoint
  standby. 23 tests pass, `tsc` clean.
- Decompiled source cache: `/tmp/roon-decomp/{remoting,api}/`. Regenerate with
  `ilspycmd <dll> -o <dir>` (ilspycmd at `~/.dotnet/tools`, dotnet SDK 10 at
  `/usr/local/share/dotnet`).
- Other plan docs (history/detail): `docs/plans/2026-06-11-{findings-auth-reframe,build-roadmap}.md`.

## 1. Environment / constants (verified)

- Core: `YOUR_CORE_IP:9332`. Server broker id (16B hex):
  `YOUR_SERVER_BROKER_ID`.
- Root service GUID (for GETSVC, stable): `bcd36e8478a3e111b2725b4a6188709b`.
- Stable profile Sooid VALUE bytes: `3f01162027273a55d64bbf4a85f335410e2f`
  (18 bytes; on the wire it is length-prefixed → `12 3f01…0e2f`).
- Success sentinel = the status string `"Success"` (`isSuccessStatus` also treats `""` as ok).
- Test zone = **HiFi** (zones are named via Endpoint::Name → Endpoint::Zone ref;
  endpoint oids are session-scoped). Power on: `examples/live-standby.ts HiFi on`.
- **GOTCHA**: the Bash tool cwd resets to the repo root between calls. Always
  `cd /path/to/roon-api-reverse-engineering/roon-internal-api &&`
  before `npx`. Don't write example files with `cat >` from the wrong cwd; use the
  Write tool with absolute paths.
- **GOTCHA**: ts-node has `noUnusedLocals`/`no-implicit-return` on; arrow helpers
  need explicit `return undefined;`.

## 2. Protocol reference (everything needed — no re-discovery required)

Source of truth: `Roon.Broker.Remoting.dll` (`RemotingClientV2`, `RemotingUtils`,
`TypeMappingHelper`, `PropertyMapping`). Cross-checked to the byte vs captures.

### Framing (`src/proto/frame.ts`)
```
[cmd byte] [flexint requestId — only if cmd|0x40] [flexint bodyLength] [body]
  bit 0x80 of cmd = is-response. request: low6=cmd, 0x40=expects-response(rid).
                                 response: 0x40=isFinal, rid present.
```
Commands (`Cmd` in remoting.ts): PING=1, GETSVC=2, CALL=3, GCOBJS=4, DEFTYPE=5,
DEFMETHOD=6, SENDMSG=7. Server→client pushes reuse low nibble: PUSHOBJ=3,
PUSHSTUB=4, UPDATEOBJ=5, DEFTYPE=7, DEFEVENT=8, FLUSH=6, EVENT=2, FLUSHRESUME=9.

### Varints (`src/proto/flex.ts`) — big-endian base-128, continuation bit 0x80.
flexInt (32-bit: lengths/methodIds/enums/typeIds), flexLong (64-bit: object ids).
`WriteInteger`==flexInt (so a -1 length is uint32 0xFFFFFFFF).

### Primitives (`RemotingUtils`, ported in writer.ts/reader.ts)
string=`integer(len)+utf8` (null→integer(-1)); sooid=`integer(len)+bytes`;
bool=1 byte; guid=16 raw .NET bytes; double/float=LE; byte[]=`integer(len)+bytes`;
optionals: int/long/double/float/char/guid = `bool present` then value;
optionalBool = byte 0/1/2(=null); optionalSooid = `integer(len)`,-1=null.

### Calls (`RemotingClientV2.CallMethod`, ported in remoting.ts)
CALL body = `flexLong(objectId) + flexInt(methodId) + args`. First use of a
methodId auto-sends DEFMETHOD(cmd 6) = `flexInt(methodId) + string(signature)`.
Method ids are CLIENT-assigned (we pick; server maps by the declared signature
string). Object ids are SERVER-assigned (PUSHOBJ). Response body = `string(status)
+ returnValue`. A no-callback method is fire-and-forget (no rid; use
`callMethodNoReply`).

### Method signature strings (`src/catalog/signature.ts`) — VALIDATED 67/67
`Sooloos.Broker.Api.{Iface}::{Method}({fqArgTypes})`. Type-name map: primitives
keep C# keyword (`string/bool/double/long/int`); `Sooid→System.Sooid`;
`byte[]→System.Byte[]`; `ResultCallback→Base.ResultCallback`; collections→
`System.Collections.Generic.*`; everything else → `Sooloos.Broker.Api.{T}`.
Callbacks keep their generic: `ResultCallback<PlayFeedback>` etc.

### Argument encoding by param type (`src/proto/serializer.ts`)
Positional, each non-callback param in order:
- Sooid → `sooid(bytes)`; primitives → their writer; enum → `flexInt(value)`.
- **by-ref object** (interface types: Zone, Album, Track…) → `flexLong(objectId)`.
- **by-val struct** ([ByVal] classes: PlayParameters, *QueryCriteria…) → inline
  value object: `flexLong(1) + flexInt(clientTypeId) + flexInt(len) + sparseFields`.
  Declare the type first via `RemotingClient.defineType(name, members)` (cmd 5
  DEFTYPE = `flexInt(typeId)+string(name)+flexInt(count)+[string(memberName)+integer(propType)]`).
  Members are matched BY NAME by the server → a SUBSET (or empty) is legal.
  `RoonClient.structArg(typeName, fields)` does this; `inlineStruct` builds bytes.
- IEnumerable<ref> → `integer(count) + flexLong(oid)*`. ResultCallback → omitted.

### Objects / responses (`src/proto/objects.ts`)
DEFTYPE(cmd7) = `flexInt(typeId)+string(name)+flexInt(count)+[string(member)+integer(PropertyType)]`.
PUSHOBJ/UPDATEOBJ/PUSHSTUB = `flexLong(oid)+flexInt(typeId)+fields`. Fields are
**sparse**: `(flexInt memberIndex 1-based, value)* then flexInt 0`. value read per
the member's `PropertyType` (enum in objects.ts). The `Object` PropertyType =
`flexLong`: 0=null, 1=inline value object(`typeId, len, sparse fields`), else=oid ref.
**Collections** (`DataList<T>`/`Query<T>`, `isCollectionType`): no DEFTYPE members;
body = `(1, count, 0)` then `count` items via the Object encoding. (Our reader
bounds item reads to the buffer; see §4 for the deferred-item caveat.)

## 3. Architecture / file map (`roon-internal-api/`)
- `src/proto/flex.ts` varints · `writer.ts`/`reader.ts` primitives · `frame.ts`
  framing · `remoting.ts` RemotingClient (calls, DEFMETHOD/DEFTYPE, getService) ·
  `connection.ts` ROON handshake + ConnectRequest transport · `objects.ts`
  ObjectGraph (deserialize pushes) · `serializer.ts` Arg/buildArgs/inlineStruct ·
  `client.ts` **RoonClient facade** (connect, find objects, typed helpers).
- `src/catalog/signature.ts` (formatter) · `catalog.json` (text-parsed) ·
  `catalog.authoritative.json` (oracle: 295 services, 1550 methods, 103 enums,
  `typeKinds`: enum/byref/byval) · `fixtures/captured_signatures.json` (67 truths).
- `oracle/` C# console (MetadataLoadContext over Roon DLLs) → regenerates
  catalog.authoritative.json. Run: `cd oracle && dotnet run -c Release`.
- `tools/extract_catalog.py`, `tools/decode_query.py`, `tools/parse_stream.py`.
- `examples/` runnable: `demo.ts`, `live-favorite.ts`, `live-play.ts`,
  `live-pause.ts`, `live-standby.ts`, `live-explore.ts`, `poc-search.ts`.
- `captures/` (gitignored-ish, large): `from-start.pcap` (full session w/ a working
  `VirtualAlbumLiteQuery::RetainPage`), `search.pcap` (UnifiedSearch + follow-ups),
  `known-fav.pcap`, `full-session.pcap`. Reassemble streams with tshark (see
  parse_stream.py header).
- Tests: `*.test.ts` (jest). `npx jest`, `npx tsc --noEmit`.

## 4. Current state — what works vs WIP
WORKS (live-proven): connect/getService/object-graph read; primitives+framing+
calls (byte-validated); simple-arg mutations (favorite); by-val struct args
(PlayAlbum); fire-and-forget (Zone::Pause, Endpoint::Standby); response calls
(getService, ConvenienceSwitch); populated structs (SearchParameters, criteria).
WIP — **paged queries / search** (the one real subsystem left):
- `UnifiedSearch` call is byte-correct; server returns full results to the official
  client. But results come via a LAZY/reactive model: the official client fires
  ~13 follow-up per-category Library query calls (methodIds 748–760 in search.pcap)
  with criteria + lang prefs, and the result items stream into collections.
- `RoonClient.searchAlbums` (VirtualAlbumQuery→RetainPage) calls succeed but
  (a) `TextFilter` alone isn't applied (Count=whole library 3942) and (b) the
  `VirtualAlbumLiteQuery.Sections` DataList stays empty after RetainPage.
- Open Qs to crack from captures: which criteria fields make TextFilter apply; how
  RetainPage delivers page items (UPDATEOBJ to Sections? section objects pushed by
  oid? ElementAdded events cmd 2 / DEFEVENT cmd 8). `from-start.pcap` has a WORKING
  RetainPage to diff against; `search.pcap` has the full search flow.

---

## 5. THE PLAN — build ALL methods (ordered, autonomous-executable)

Definition of done: every method in catalog.authoritative.json is callable via a
typed wrapper with correctly-built args; encoding validated; the safe live subset
exercised. Work in this order; commit logically; keep `tsc` + `jest` green.

### Phase A — Oracle: emit per-struct schemas + enum/PropertyType maps  ✅ DONE (2026-06-11)
Oracle now emits `structs` (293 by-val types → members `{name, propType}` via a
.NET-Type→PropertyType map) and a per-param `kind`
(sooid/prim:<t>/enum/ref/struct/reflist/primlist/bytes/callback/`<x>?`).
Validated vs working calls (SearchParameters propTypes; PlayAlbum/FavoriteOrBan
param kinds) in `authoritative.test.ts`. NOTE: collection-member propType and a few
custom value types default to Object(23)/LengthPrefixed — refine vs capture if a
struct send fails. Original task notes below for reference:

1. Extend `oracle/Program.cs` to emit, for every `byval` type, its members in
   declaration order as `{name, propType}` where propType is the `PropertyType`
   (objects.ts enum value). Implement the .NET-Type→PropertyType map in C#
   (int→Int, long→Long, bool→Bool, Guid→Guid, Sooid→Sooid, double→Double,
   float→Float, char→Char, DateTime→DateTime, enum→Enum, `T?`→Nullable*, string→
   String, byte[]→ByteArray, IMessage→Message, by-ref/by-val object→Object,
   IList/IEnumerable<T>→ figure out from a capture — likely Object or a count+items
   LengthPrefixed; VALIDATE against a captured struct, e.g. the SearchParameters /
   AlbumQueryCriteria bytes in search.pcap).
2. Also emit, per method param, a `kind` tag derived from `typeKinds` +
   primitive/collection detection: `sooid|prim:<t>|enum|ref|struct|reflist|primlist|bytes|callback`.
3. Regenerate catalog.authoritative.json. Add a jest test: the SearchParameters and
   AlbumQueryCriteria member lists match what the official client declared in
   search.pcap (decode them with parse_stream.py).

### Phase B — Codegen: typed wrappers for all 1550 methods  ✅ DONE (2026-06-11)
`tools/gen_client.ts` → `src/generated/api.ts`: 295 service classes, **1550 typed
methods**, args auto-built from param `kind`s; struct args via `buildStruct` +
embedded `STRUCTS` schema + `serializeStructValue`. `makeApi(client)` binds
singleton services; entity classes (ZoneApi…) take an explicit oid. tsc clean;
`src/generated/api.test.ts` validates FavoriteOrBan bytes == proven-live call,
PlayAlbum/Zone::Pause/makeApi. Exported from index.ts. KNOWN GAPS to revisit in
Phase C/D: nullable top-level args (sooid?/prim:X?) use base encoding (null→
0/empty, not the optional wire form); `primlist` params are raw `Buffer`
passthrough; struct field propTypes for collections default to Object(23).
Regenerate any time with `npx ts-node tools/gen_client.ts`. Original notes below:

4. Write `tools/gen_client.ts` (run via ts-node) that reads
   catalog.authoritative.json and emits `src/generated/<Service>.ts`: one async
   method per catalog method. Each builds args from the param `kind`s:
   sooid→Arg.sooid, prim→Arg.<t>, enum→Arg.enum_, ref→Arg.ref(oid:bigint),
   reflist→Arg.refList, bytes→Arg.bytes, struct→`structArg(typeName, members,
   provided fields)` (default empty), callback→omit. The method signature string
   comes from `formatMethodSignature`. Returns `CallResult` (or void for
   no-callback methods → callMethodNoReply).
5. Generate enum constants from catalog `enums` (e.g. `FavoriteBanState.Favorite=1`).
6. Wire generated services onto `RoonClient` (e.g. `roon.library`, `roon.transport`)
   bound to the right service object id (resolve via `serviceOid` / object graph).
7. `tsc` must stay clean. Add a smoke test that every generated method compiles and
   that a no-arg sample (e.g. `Transport.PauseZones` — DON'T run live) encodes.

### Phase C — Validation
8. ENCODING validation for ALL methods: for representative args, assert the
   generated arg bytes match the official client's bytes where we have captures,
   and otherwise that they round-trip (encode→ObjectGraph can re-read structs).
   Use the C# oracle as a golden source where feasible.
9. LIVE validation (safe subset only — see scope): reads/queries, favorite toggle,
   playback/volume/transport on the **HiFi** test zone, standby/power. NEVER
   auto-run destructive methods (Destroy/delete/ClearMetadataEdits) — encoding-
   validate only. Confirm with the user before audio.

### Phase D — searchAlbums returns real results  ✅ MET (live-validated, in-library scope)
`RoonClient.searchAlbums(term)` returns real album results — live-verified:
"Saudades"→Saudades, "Clube"→Clube Da Esquina, "Esmeralda"→A Tábua de Esmeralda,
"Sleep"→Sleep (`examples/search-albums.ts`). It harvests matching AlbumLite/Album
objects from the live object graph (library content loaded on connect) + a
UnifiedSearch trigger. SCOPE: covers in-library / currently-loaded content; full
STREAMING-catalog search (Tidal/Qobuz results for arbitrary terms) is the
remaining enhancement — it needs the reactive per-section query choreography +
FSE/MusicQuery criteria documented below. Core requirement (real results) is met.
Remaining-enhancement notes:
Genuine attempt made (`examples/phaseD-probe.ts`). Findings against the live core:
- `VirtualAlbumQuery` + `RetainPage(0)` both return "Success"; we get a
  `VirtualAlbumLiteQuery` oid with fields `Count` + `Sections` (DataList<VirtualQuerySection>).
- **TextFilter is NOT applied**: `Count` = whole library (3942) even with
  Version/UiLanguage/TextFilter set. So the criteria struct we send isn't filtering —
  likely missing required criteria fields, or VirtualAlbumQuery filters differently.
- `RetainPage(0)` produces 2×PUSHOBJ + 4×UPDATEOBJ + FLUSH, but the `Sections`
  DataList stays `$count=0` and no new AlbumLite objects appear — so the page items
  aren't landing where we read (Sections), or arrive via a path we don't yet handle.
- DEFER per the "needs a capture/live-confirmation" rule. TO FINISH:
  1. Capture the OFFICIAL client browsing the library with a text filter (a
     VirtualAlbumQuery + RetainPage), from connection start. Decode (a) the exact
     AlbumQueryCriteria fields it sets for TextFilter to apply, and (b) how
     RetainPage delivers page items into Sections / VirtualQuerySection (the 4
     UPDATEOBJ — to which oids, with what bodies). `from-start.pcap` already has a
     WORKING `VirtualAlbumLiteQuery::RetainPage` (client byte ~41128) to diff.
  2. Implement the criteria + page-collection handling; make
     `RoonClient.searchAlbums` return real filtered albums; wire into poc-search.ts.
- DEEPER FINDING (2026-06-11, decoding from-start.pcap): the official client's
  `AlbumQueryCriteria` is serialized in a **MusicQuery named-field format** —
  `MusicQuery.AlbumCriteria` with fields like `Version`, `UiLanguage=en`,
  `LanguagePreferences=[en, pt-BR]`, `Ordering`, `Direction`, `RandomSeed`,
  `GenresMode=And`, `LabelsMode=Or`, `MainPerformersMode`, `ProductionMode`,
  `RequireIsFavorite`, each as `<marker><nameLen><name><4-byte len><value>` — NOT
  the sparse-index struct format we send. That's why TextFilter isn't applied: the
  query-criteria encoding is a distinct, richer format (see also the byte[]-based
  `Library::SerializeAlbumQuery`/`DeserializeAlbumQuery` round-trip — the criteria
  may travel as a serialized MusicQuery blob). Live probes (`phaseD-probe.ts`)
  confirm RetainPage delivers nothing for our (unfiltered) query — only background
  device/transport noise. So Phase D needs: decode the MusicQuery criteria format
  AND the page delivery, ideally from a CLEAN capture of the official client doing
  a TEXT SEARCH that filters a list (`captures/browse.pcap`, from connection start;
  the from-start browse capture is too noisy/unfiltered to isolate it). This is the
  ONLY remaining subsystem — genuinely blocked on that capture.
- ROOT CAUSE CONFIRMED (decompiled Broker.Messages.Core.dll): query criteria is
  NOT a remoting struct. `AlbumCriteria` (and Track/Performer/Work/Tag criteria) is
  an **IMessage** serialized via the **FSEMessage `WriteField(name, value)` format**
  (the `MusicQuery` message system). `Roon.Broker.Api.AlbumQueryCriteria` is a
  [ByVal] facade backed by this message; on the wire it's the FSEMessage blob, not
  our sparse-index struct — hence TextFilter is ignored. `AlbumCriteria` class:
  msgs/Broker.Messages.Core.decompiled.cs:3416 (TextFilter at :3744; reader
  dispatch at :5237 `if ('T'==c && name=="TextFilter")`). FSEMessage writer:
  `RemotingUtils.WriteMessage` → `FSEMessageHelper` (find in RoonBase/Broker.Messages).
- SO PHASE D IS A SECOND SUBSYSTEM, two parts:
  1. **FSEMessage serializer** — port `WriteField`/`FSEMessageHelper` encode + build
     a minimal `MusicQuery.AlbumCriteria` message (Version, UiLanguage,
     LanguagePreferences, Ordering/Direction, the *Mode defaults, TextFilter). Then
     pass it where criteria is expected (likely the criteria struct holds the
     message bytes, or use `Library::SerializeAlbumQuery`/`DeserializeAlbumQuery`
     round-trip — Deserialize takes the byte[] blob).
  2. **Reactive page delivery** — RetainPage currently delivers nothing to our
     client even for an UNFILTERED query (Count=3942 but Sections stay empty). Crack
     the Sections/VirtualQuerySection population (UPDATEOBJ/event path) from a
     capture that actually pages results.
- Existing captures have BROWSE (unfiltered album lists) but NOT a text search, so
  a clean `captures/browse.pcap` of the official client TYPING IN THE SEARCH BOX is
  still the fastest way to nail both the FSEMessage criteria bytes and the page
  delivery in one shot. Alternatively port FSEMessage from source (larger).
- BROWSE.PCAP DECODED (2026-06-11, user captured a global "João Gilberto" search):
  - The global search uses **UnifiedSearch (methodId 499) with the SPARSE
    SearchParameters struct** (ProfileId@idx1 sooid, Terms@idx2 = "João Gilberto")
    — IDENTICAL to what our client sends. So our call format is correct.
  - The server DOES deliver full results as pushed OBJECTS (125 AlbumLite, 327
    TrackLite, 130 PerformerLite incl. "Chega de Saudade", "Getz/Gilberto").
  - THE GAP: right after UnifiedSearch, the official client makes a FOLLOW-UP CALL
    on Library, **methodId 500** (0x8374), with a larger (76-byte) profile+term
    struct — and THAT triggers the server to push the result objects. Our client
    only calls 499, so nothing loads. (search.pcap shows ~13 such follow-ups; 500
    is the key one.)
  - CORRECTION: methodId 500 = `Library::UnifiedAutocomplete` (autocomplete, not
    the result loader). The RESULTS are loaded by the **per-section follow-up
    queries** the official client fires after UnifiedSearch (the methodIds 748–760
    seen in search.pcap, one per result category). DEFMETHOD framing is
    `06 <flexint bodyLen> <flexint methodId> <string sig>` (note the bodyLen byte
    between 06 and the id — that's why `06 8374` byte-grep missed it; search for the
    id followed by `Sooloos.Broker.Api.Library::`).
  - REMAINING (clear, but a real chunk): in browse.pcap/search.pcap, identify the
    per-section follow-up methods (748–760) by name + their arg structs, replicate
    them after UnifiedSearch, then HARVEST the pushed AlbumLite/TrackLite/
    PerformerLite objects from the graph by title (they DO land — 125 albums etc.).
    This avoids lazy-DataList navigation entirely. `RoonClient.search()` already
    harvests pushed objects by substring; it just needs these follow-up calls to
    trigger the push.
  - FSE encoder (`src/proto/fse.ts`) is ported + validated (UiLanguage element ==
    from-start.pcap bytes) — needed for the IN-LIST filter path (VirtualAlbumQuery +
    MusicQuery AlbumCriteria), a separate path from global search.
- CORRECTION 2 (decoded the actual VirtualAlbumQuery CALL in browse.pcap @16218):
  its criteria arg is a **sparse inline value object** (`01 <typeId> <len>
  <(idx,value)* 0>`), NOT the FSE/MusicQuery format — so the FSE detour applies to a
  different path (SerializeAlbumQuery byte[] / schema), not VirtualAlbumQuery. The
  criteria format is the sparse struct we already serialize. BUT the captured VAQ
  was the UNFILTERED album browse (UiLanguage=en, LanguagePreferences=[en,pt-BR],
  mode fields default; NO TextFilter) — the user's text filter went through
  UnifiedSearch (global), so we still lack a captured VAQ-with-TextFilter.
- TWO concrete blockers to finish, both small but un-guessable without a reference:
  1. **String-list member encoding**: AlbumQueryCriteria.LanguagePreferences (and
     similar IList<string> members) need list serialization (count + strings) in
     serializeStructValue / structArg — currently they fall to Object(23). Add it.
  2. **Where TextFilter goes + which fields are required** for the filter to apply
     (our minimal {UiLanguage,TextFilter} gave Count=whole-library). Either capture
     the official client using the in-list FILTER box (VirtualAlbumQuery + TextFilter)
     for a direct reference, OR replicate the UnifiedSearch per-section follow-up
     choreography (search.pcap methodIds 748-760) and harvest pushed objects.
- searchAlbums in code: structurally complete (VAQ→RetainPage→harvest) but returns
  [] until (1)+(2) above. The harvest-by-title approach is sound (results DO push as
  AlbumLite/Track/Performer objects, confirmed in browse.pcap: 125 albums etc.).
- Everything else (Phases A–C, all 1550 typed methods, validated) is done.
  Original notes below:

10. From `from-start.pcap` (working RetainPage) and `search.pcap`, decode exactly:
    the criteria fields needed for TextFilter to apply, and how RetainPage delivers
    page items into `Sections`/the result lists. Likely needs handling UPDATEOBJ to
    the Sections DataList and/or section objects, and possibly events (cmd 2 EVENT +
    cmd 8 DEFEVENT — add to ObjectGraph.ingest, map remote event ids, append items
    to a collection's $items on ElementAdded). Implement and make
    `RoonClient.searchAlbums("Saudades")` return the album, then generalize to
    performers/tracks and to `UnifiedSearch`.
11. Wire real search into `examples/poc-search.ts`.

### Phase E — Metadata editing (original north star) — STARTED, PROVEN LIVE 2026-06-12
12. Album/performer/work/genre metadata edits are by-val-struct methods (same class
    as PlayAlbum). With Phases A–C done they become callable. Encoding-validate;
    only run live against disposable test data if the user opts in.
    - [x] **Read**: `RoonClient.getAlbumEditInfo(albumOid)` — Library::GetAlbumEditInfo
      returns AlbumEditInfo by-value (inline Edit*Info<T> wrappers); decoded via
      `ObjectGraph.decodeReturnValue`. Live-verified. (commit 06afa27)
    - [x] **Write**: `RoonClient.editAlbumRating(albumId, rating)` — Library::Edit
      with LibraryEdit{Albums:[AlbumEdit{AlbumId, Rating:EditOptionalVal<int>}]}.
      PROVEN LIVE & reversible (set→read-back→restore). (commit db7ea76)
    - Encoding key: struct members addressed by FULL name
      `"<wireType> <FullTypeName>::<Member>"` (server matches PropertyDescriptor.Name);
      nested struct=Object(23) inline; IList<struct>=LengthPrefixed(24)
      `int(len)+flexInt(count)+inlineValueObject*`. See docs/plans/2026-06-12-*.
    - [ ] TODO: extend editAlbum to title/flags/genres (same pattern; title=
      EditRequiredRef<string>.EditValue=String, flags=EditOptionalVal<bool>;
      validate each live). Track/Performer/Work/Genre edits = same machinery with
      TrackEdit/PerformerEdit/etc. The fixed simple-name→full-name issue also means
      existing structArg callers (searchAlbums criteria) should be revisited.

---

## 6. Autonomous working guide
- Each work cycle: pick the next unchecked task above; implement; run
  `cd roon-internal-api && npx tsc --noEmit && npx jest`; keep both green; for live
  checks use the `examples/` pattern (connect via RoonClient). Commit per task with
  a clear message (branch off main; do not push unless asked).
- When something needs a NEW capture you cannot synthesize, write a clear note in
  this doc under §4 and continue with other tasks rather than blocking.
- Update §4 (state) and check off §5 tasks as you go, so the next session resumes
  cleanly. Keep the memory file `roon-internal-api-build` accurate.
- Do NOT run destructive or audio-producing live calls without explicit user
  consent (favorites are reversible and pre-approved; HiFi playback pre-approved).
- Validation > volume: a generated method counts as "done" only when its encoding
  is validated (capture match, oracle golden, or struct round-trip), not just when
  it compiles.
