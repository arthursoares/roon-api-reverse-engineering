# Findings: The "auth wall" is likely a misdiagnosis (2026-06-11)

Investigation resumed with the goal of cracking local-mutation authorization on
port 9332. Analyzed the two independent captures already on disk
(`full-session.pcap`, `fresh-favorite.pcap`) and ran a live byte-perfect favorite
test against the core. Results materially change the project's central assumption.

## What was proven

1. **No authentication material exists in the local 9332 protocol.**
   Scanned the entire 81 KB official-client→core stream from `full-session.pcap`
   for `auth`, `token`, `sign`, `cred`, `login`, `session`, `roonlabs`, `account`,
   `key`, etc. across all 1,440 length-prefixed strings. The only hit was a
   coincidental substring (`...SortKey`). There is **no auth token, credential,
   signature, or HMAC sent over 9332**. → The cloud auth token
   (redacted) is never transmitted on the local connection. The
   "cloud-first auth enables local mutations" theory has no supporting evidence
   in the wire data.

2. **The FavoriteOrBan dispatch token `1b 2d` is stable across sessions.**
   Both captures use the identical token `1b 2d` for the same method, despite
   being different sessions. So the token is a fixed method identifier (not a
   sequentially-assigned per-session index). Our replay token is correct.

3. **The 4-byte field after the track id is a session-specific ResultCallback handle.**
   - `full-session.pcap` favorite call:  `... 410e2f 86 8e f2 47 <state>`
   - `fresh-favorite.pcap` favorite call: `... 410e2f 86 87 93 0f <state>`
   Track ref (`123f...410e2f`), token (`1b 2d`), and state byte are identical;
   only this field differs. The server stream contains an incrementing sequence
   of these handles (`8ef246, 8ef247, 8ef248, ...`), i.e. they are allocated
   handles, scoped to a session.

4. **The documented "server replies Success" was a misread.**
   No `Success` response correlates to the favorite call. The `Success`
   occurrences in the server stream are unrelated (`Successful`, JSON
   `"status":"Success"`, `LastSuccessful`).

5. **A byte-perfect favorite call is dropped with ZERO response (live test).**
   `examples/favorite-verify.ts` completes the handshake, receives ~341 KB of
   schema, sends the exact FavoriteOrBan registration, then sends the exact
   official call format (`43 55 1b 2d 84 54 <trackref> 86 8e f2 47 01`). With
   device-discovery (`0x05 _raop`) and keepalive noise filtered out, the server
   returns **nothing at all** in a 6s window — not even an error. The official
   client always received a reply here.

## RESOLVED (2026-06-11): there is no local auth — we replayed dead session handles

A controlled capture (`captures/known-fav.pcap`) of the official client
favoriting then unfavoriting a known track ("Coisa Maluca") settles it.

Client→core bytes, in frame order:
```
frame 7 (150b)  06 8113 8420 810f <Sooloos...Library::FavoriteOrBan(...)>   REGISTER
frame 8 (29b)   43 07 1a2e 8420 123f01162027273a55d64bbf4a85f335410e2f a0c30101  CALL favorite ON
frames 9-27     <server pushes 19,907 bytes of Coisa Maluca album/track data>   <-- it WORKED
frame 40 (29b)  43 24 1a2e 8420 123f...410e2f a0c30100                       CALL favorite OFF
```

Decisive facts:
- **Frame 8 (the call) immediately follows frame 7 (the registration) with NO
  server packet in between**, yet the server acted (massive Coisa Maluca push).
  => the method handle is **client-assigned** in the `06` registration and used
  immediately; no server ack, no auth, nothing.
- The `84 XX` byte in the registration EQUALS the `84 XX` in the call
  (`84 20` here; `84 54` in the old `full-session.pcap`). It is a
  **session-local method handle the client picks**.
- Comparing the SAME track across sessions, these all change per session:
  dispatch token `1a 2e` vs `1b 2d`; method handle `84 20` vs `84 54`;
  callback `a0 c3 01` vs `86 8e f2 47`. Only the 19-byte **track ref**
  (`123f...410e2f`) is stable (Coisa Maluca's persistent id).

### Why our client's calls were silently dropped
`debug-flow.ts` / `examples/favorite-verify.ts` hardcode `1b 2d 84 54` and
callback `86 8e f2 47` — handles from a **dead session** in an old capture. The
live server never bound those handles this session, so it cannot dispatch the
call and drops it. **This was never an authorization problem.** The "ALL control
operations require authorization" conclusion in older notes is wrong; those
calls failed for the same reason (stale/invalid handles, or never-registered
methods), not auth.

## FULLY DECODED (2026-06-11) via `captures/from-start.pcap`

A second controlled capture — from connection open, favoriting a DIFFERENT known
track ("desde que o samba e samba") — corrected an earlier mislabeling and
revealed the true call structure.

### The favorite call, correctly decoded
```
43  <msgid>  1a 2e   84 20         123f01162027273a55d64bbf4a85f335410e2f   <TrackBase>  <state>
└call └id    └cb     └method        └arg1: profile/context Sooid (19b)        └arg2        └arg3
             handle   =FavoriteOrBan   (CONSTANT — same in every Library call)  =track       0=ban/1=fav
```

- **`123f...410e2f` is NOT the track.** It is the `System.Sooid` first argument
  (profile/library context) that nearly every Library method takes — it appears
  600× in the server stream across unrelated calls (album queries, OneBox, etc.).
  It is constant for this user. The earlier notes wrongly called it the track id.
- **The TrackBase (arg 2) is the bytes AFTER the Sooid, and it varies per track:**
  - "Coisa Maluca":  `... 410e2f  a0 c3 01  01`
  - "desde ... samba": `... 410e2f  a1 8c 67  01`
  It is an **ephemeral session handle** (marker `0xa0`/`0xa1` + value), NOT a
  persistent id. Proof: `a1 8c 67` appears in the SERVER stream (byte ~822281)
  immediately beside the track's name and its `broker:///image/...` cover-art URL
  — i.e. the server assigned the handle when listing the track, and the client
  reused it. The handle is only valid while the server retains that query page
  (cf. `VirtualPlaylistItemQuery::RetainPage`, `...LiteQuery::RetainPage`).
- **`1a 2e 84 20` — SUPERSEDED by the source-verified decode below.** The real
  split (from the decompiled `SendRequest`/`CallMethod`) is: `1a`=body length (26),
  `2e`=objectId (46, the Library service object), `84 20`=methodId (544 =
  FavoriteOrBan, declared via the `06` DEFMETHOD). See the BREAKTHROUGH section.

### Consequence: favoriting is browse-then-mutate
You cannot favorite by a stable track id. You must:
1. Browse / query so the server returns the track object **with its ephemeral
   TrackBase handle** (and keep that query page retained), then
2. Call `FavoriteOrBan(profileSooid, trackHandle, state, callback)` using that
   handle.

## What a working client must implement (pure protocol, no auth)
1. Handshake + schema (already working).
2. `06` registrations declaring our method handles (client-chosen; `84 XX` reused
   in the call). Also register the query methods (`VirtualAlbumQuery`,
   `DeserializeTrackQuery`, browse methods) and `RetainPage`.
3. A query to list tracks/albums and parse the response to extract each item's
   ephemeral handle + name. This is the bulk of remaining work: decode the
   query-response object encoding well enough to map name -> handle.
4. Emit `FavoriteOrBan` with the profile Sooid (stable, read it from any captured
   call: `123f01162027273a55d64bbf4a85f335410e2f`), the chosen track handle, and
   state byte.

### Query-response decode — DONE (de-risked 2026-06-11)
`tools/decode_query.py` decodes a server query/browse response and extracts
`(name -> ephemeral track handle)` pairs, verified against ground truth.

Encoding learned:
- Object handle reference: `a1 <hi> <lo>` (also `a0 ...`). 2-byte session-local id.
- Tagged field: `<tag:1> <len:1> <utf8 bytes>`. A **name-bearing object** is
  `a1 HH HH  03 <len> <Title>  04 <len> <sortkey>  05 <len> <display>`.
- A **track object** links to its name object by adjacency:
  `a1 <TRACK>  03 <len> a1 <NAMEOBJ>`  (`<len>` varies: 0x09, 0x0c, ...).
- Join the two to get TRACK handle -> Title.

Result on `from-start.pcap` (an album track view):
```
a18c63 -> 'Aos pés da cruz'       a18c68 -> 'Desafinado'
a18c66 -> 'Tim tim por tim tim'   a18c6c -> 'Você e Eu'
a18c67 -> 'Desde que o samba é samba'  (== the handle favorited in capture ✓)
a18c6d -> 'Eu vim da Bahia'
```
Track handles are sequential per page (`a18c63..a18c6d`). The favorited track's
handle `a18c67` was recovered purely from its name — proving the
browse-then-mutate path is buildable.

### Remaining (minor) decode tasks
- A few name objects in the page weren't linked (different field-length / nested
  context, e.g. 'O pato', 'Doralice'). Tighten the link rule for full coverage.
- The handle/callback marker encoding (`0x84`,`0x86`,`0xa0`,`0xa1` + value) as a
  function of value magnitude — needed to MINT our own handles when we issue the
  registration+call (vs. only reading the server's).
- Which query method to send to get a flat track list with handles
  (`VirtualAlbumQuery` / `DeserializeTrackQuery` + a `RetainPage`).

## Files

- `examples/favorite-verify.ts` — live byte-perfect favorite + filtered response capture
- `tools/parse_stream.py` — walks a client/server hex stream, extracts strings/types
- `/tmp/roon-analysis/{client,server,fresh-cli}.hex` — reassembled streams (regenerate via tshark)

---

## BREAKTHROUGH: decompiled the actual protocol (2026-06-11)

Roon ships **unobfuscated** Mono/.NET assemblies in
`/Applications/Roon.app/Contents/MonoBundle/`. Decompiled with `ilspycmd` (C#).
This replaces wire-inference with reading the source.

Key assemblies:
- `Roon.Broker.Remoting.dll` — the RPC/serialization layer (THE protocol).
- `Roon.Broker.Api.dll` — full method+type catalog with real signatures.
- `RoonBase.dll` — serialization primitives.

### Message framing (from `RemotingBaseProtocol.SendRequest`)
```
[cmd:1] [flexint requestId — ONLY if callback expected] [flexint bodyLength] [body]
```
- cmd byte gets `| 0x40` when a response is expected (carries a requestId).
- `Commands`: PING=1(0x41), GETSVC=2(0x42 — our "schema trigger" is GET-SERVICE),
  CALL=3(0x43), GCOBJS=4, DEFTYPE=5, DEFMETHOD=6(0x06), SENDMSG=7(0x47).
  Client→server (pushes): PUSHOBJ, PUSHSTUB, UPDATEOBJ, DEFTYPE, DEFEVENT, FLUSH.

### Varint: `RemotingUtils.WriteFlexInt` — big-endian base-128, continuation bit 0x80
Confirms our wire deduction (`81 0f` = (1<<7)|15 = 143). FlexLong is the 64-bit form.

### Method calls (`RemotingClientV2.CallMethod` + `_WriteMethodId`)
```
CallMethod(objectid, methodid, args):
  body = WriteFlexLong(objectid) + _WriteMethodId(methodid) + args
  SendRequest(3, body, callback)              // => wire 0x43

_WriteMethodId(methodid):
  if first use of methodid this connection:
     SendRequest(6, WriteFlexInt(methodid) + WriteString(name))   // => DEFMETHOD 0x06
  WriteFlexInt(methodid)
```
`WriteString = WriteInteger(utf8len) + utf8bytes`.

### Verified to the byte against the captured favorite
`43 07 1a2e 8420 <profile19b> a18c67 01`:
- `43`=CALL|0x40, `07`=requestId, `1a`=bodyLen 26 (body is exactly 26 bytes ✓)
- body: `2e`=objectId 46 (the Library service object), `8420`=methodId 544 (FavoriteOrBan),
  args = profile Sooid (19b) + `a18c67`=track objectId 546407 + `01`=FavoriteBanState.

The "session-specific handles" mystery is fully explained: method IDs are
client-assigned ints (auto-declared via DEFMETHOD); object IDs are server-assigned
flexlongs from PUSHOBJ. Nothing is authenticated.

### Consequence for the build
Port `RemotingClientV2` + `RemotingUtils` + the per-type argument serializers
(`TypeAdapter`/`TypeDescriptor`) straight from the decompiled source rather than
inferring from wire. Every method (incl. metadata editing) then becomes
"call by name with serialized args" — the catalog comes from `Roon.Broker.Api.dll`.

Decompiled source cached at `/tmp/roon-decomp/remoting/` (regenerate via
`ilspycmd <dll> -o <dir>`).
