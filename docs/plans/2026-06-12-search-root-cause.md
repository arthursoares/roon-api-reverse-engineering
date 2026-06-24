# Search / paged-query root cause (2026-06-12)

## TL;DR (revised after capturing `from-start.pcap` frame analysis)
Full-catalog **search and paged browse don't work yet** because we haven't
replicated the official client's **query-construction + page-retain choreography**
— NOT because of a missing session/event capability. An earlier draft of this doc
blamed "the core sends us no events"; the capture **disproves** that as the
blocker (see below). Page/section results are delivered by **UPDATEOBJ (cmd 5),
which we already decode** — the problem is our query is set up such that the
server never pushes those updates to it.

## What the capture actually shows (`captures/from-start.pcap`)
Parsed both directions into remoting frames (`/tmp/parse-frames.mjs`):
- **server→client**: `3:7197 PushObj, 4:1951 PushStub, 5:322 UpdateObj,
  6:95 Flush, 7:186 SendMsg, 8:1 DefineEvent, 2:1 Event`.
  → The official client received **exactly one** event in the whole session.
  Events are NOT the bulk delivery mechanism; **UPDATEOBJ is** (322 of them).
- **client→server** call sequence around the search (`/tmp/decode-calls.mjs`):
  `…SerializeAlbumQuery / DeserializeAlbumQuery / Serialize{Performer,Work,Tag,
  Track}Query …  Library::VirtualAlbumQuery(oid46) → returns VirtualAlbumLiteQuery
  oid → VirtualAlbumLiteQuery::RetainPage → Album::GetAlbums ×N → OneBox* …`.
  The official client builds queries via **Serialize/Deserialize*Query** (a
  byte[]-roundtripped criteria), not a hand-built inline struct.

## Facts established (so we don't re-litigate)
- `AlbumQueryCriteria` is a **118-member** ByVal struct (full layout dumped via
  `/tmp/decode-criteria.mjs`). `TextFilter` = member #11 (string); `Ordering` #1,
  `UiLanguage` #2, `LanguagePreferences` #3, plus dozens of `*Mode`/`Require*`/
  `Exclude*` members.
- The server maps a client-`DEFTYPE`'d struct's members **by name**
  (`TypeMappingHelper.DefineType`: `text2 == propertyDescriptor.Name`), so our
  2-field subset (`UiLanguage`,`TextFilter`) **is** mapped to the right slots.
  → The ignored `TextFilter` is therefore **not** a member-index bug; the server
  simply doesn't text-filter on `TextFilter` alone (text search proper goes
  through `UnifiedSearch`; `VirtualAlbumQuery` is the *browse/filter* path).
- Our live `VirtualAlbumQuery` returns `Count = 3942` (whole library) and
  `RetainPage(0)` → `Success` but **0** UPDATEOBJ to the query/sections (the 5
  cmd-5 we saw were unrelated zone-seek streaming). The official client's
  identical-looking RetainPage *does* get section pages. The delta is in the query
  setup / surrounding choreography, still to be pinned down.
- Events (cmd 2/8) are still **unhandled** in `objects.ts`, but that's a minor gap
  — only 1 event mattered in the whole official session, and it is not how pages
  arrive.

## Decompiled references (in `/Applications/Roon.app/Contents/MonoBundle/`)
- `Roon.Broker.Remoting.dll`: `RemotingClientV2.OnRequestReceived` (cmd 2=OnEvent,
  8=OnDefineEvent); `RemotingServerV2.NotifyEvent`/`_PutObject`→`TypeAdapter.Bind`;
  `TypeMappingHelper.DefineType` (by-name member mapping).
- `Roon.Broker.Api.dll`: `RemoteQueryProxy.Populate` reads a DataList's count +
  inline items from an UPDATEOBJ body.
- `Roon.Broker.Concurrency.dll`: `SharedObject.AddHandler` is local-only.

## To make paged browse/search work (ordered, tractable)
1. Replicate the official **VirtualAlbumQuery** byte-for-byte: full criteria
   (Ordering + UiLanguage + LanguagePreferences + the `*Mode` defaults the client
   always sets) and `VirtualQueryParameters{PageSize, CopySelectionState}`. Decode
   the official call body (`/tmp/decode-vaq.mjs` has it) field-by-field against the
   118-member layout, then send the same. Verify `RetainPage(0)` yields UPDATEOBJ
   to the query's `Sections`.
2. If pages still don't arrive: capture a fresh **text search** (UnifiedSearch +
   the per-category follow-ups, methodIds 740–760) — the repo's referenced
   `search.pcap` is missing — and replicate that choreography.
3. Decode the `Sections`→`VirtualQuerySection`→page-item delivery so
   `searchAlbums`/a new `browseAlbums` drains real pages.

## Web client impact / current behavior
`roon-web` search is scoped to the objects already pushed this session (~7 albums,
~54 artists, 157 playlists, 24 genres, tracks/works) and labels that scope. Full
catalog browse/search is blocked on item 1 above — a faithful query-encoding
replay, not a session-capability change.
