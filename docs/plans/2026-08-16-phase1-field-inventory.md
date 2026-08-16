# Live field-inventory probe of the internal 9332 protocol (2026-08-16)

Read-only connect to a live Roon Core over the internal protocol (TCP 9332) and a
full DEFTYPE-schema inventory of the Album/Track entity types. Answers whether a
"newly-added streaming album" detector can harvest from the live object graph, and
documents exactly how the streaming-service signal is carried.

## Method

`examples/live-fields.ts` connects via `RoonClient` (handshake: SENDMSG frame with a
client-broker-id placeholder, then a DEFTYPE schema dump), and dumps:
- the **pushed** object field keys per type (what the Core actually populates), and
- the **DEFTYPE schema** member list per type (the authoritative full field set).

`examples/full-schema.ts` calls `Library::GetAlbum(long)` / `GetTrackLite(long)`
(read-only) so the Core DEFTYPEs the full `Album`/`Track` entity types.
`examples/pushed-values.ts` / `examples/checktypes.ts` are the read-only helpers that
enumerate the defined type set and the pushed field values.

## Development environment & methodology

This reverse-engineering was produced with a **fully local agentic setup** — the
relevant point is that no external hosted API or service was used:

- **Coding agent**: `omp`, a local coding-agent harness (not Claude/OpenAI via
  hosted APIs).
- **Inference engine**: a **local, open-weight model** (`DeepSeek-V4-Flash`,
  `IQ2XXS` quantized GGUF, ~81 GB, ~8.9 tok/s) served by the local `ds4`
  ("DwarfStar") engine on an AMD Strix Halo workstation (Ryzen AI MAX+ 395,
  122 GB) on the LAN — OpenAI-compatible endpoint `http://max:8084/v1`. The model
  weights are public and the inference runs on hardware we control.
- **Probe target**: a live Roon Core (`Nova`, `192.168.178.30:9332`, internal
  protocol, serverBrokerId `465f021738d44b46bbe84c20a05a313b`).

So the workflow is: local coding agent (omp) → local open-weight inference engine
(ds4/DwarfStar) → live Roon Core — no third-party API anywhere in the loop.

## Field-name inventory (authoritative DEFTYPE schema)

### AlbumLite (typeId 458, 60 members)
No `Service`/`ServiceName`/`Added`/`DateAdded`/`IsStreamable`/`IsQobuz`/`IsTidal`/
`IsDownloadable`/`IsOffline`/`IsDownloaded`. Present instead:
- `Source` / `ContentSource` — `Sooloos.Broker.Api.MediaSource` enum
- `ImportDate` — `System.DateTime?` (the "added" date)
- `IsDownloadSupported`, `IsExportSupported` — bool
- `ReleaseDate`/`OriginalReleaseDate`/`RecordingStartDate`/`RecordingEndDate`
- `Broker` — Broker object ref

### Album (typeId 471, 92 members, defined on GetAlbum)
Same as AlbumLite plus **service-specific persistent ids**:
- `TidalAlbumId` (`long?`), `QobuzAlbumId` (`long?`), `KKBoxAlbumId` (`long?`)
- `Tracks` (DataList<Track>), `SourceAlbumIds`, `IsAvailable`, `ProductCode`,
  `CatalogNumber`, `Country`

### TrackLite (typeId 466, 56 members)
No `Service`/`IsStreamable`/`IsQobuz`/`IsTidal`/`IsDownloadable`/`IsOffline`.
Present: `Source`/`ContentSource` (MediaSource), `ImportDate`, `AddedTime`,
`ModificationTime`, `IsDownloadSupported`, `IsPlayable`, `IsAvailable`,
`ContentLocation`, `PathName`, `FileSize`.

### Track (typeId 475, 64 members, defined on GetTrackLite)
No service-id fields on Track itself; `Source`/`ContentSource` (MediaSource),
`ImportDate`/`AddedTime`/`ModificationTime`, `IsDownloadSupported`,
`SourceTrackIds` (DataList<long>).

## MediaSource enum (the "service" signal)

```
Local=1, MetadataService=8, None=16, IHeartRadio=32,
Tidal=128, Qobuz=256, Streaming=512, Hiro=1024, KKBox=2048, Nugs=4096
```
The `Source`/`ContentSource` field carries this enum — so the streaming service
**is** identifiable on every Album/AlbumLite/Track/TrackLite object.

## Live value check (pushed objects + full Album via GetAlbum)

Pushed AlbumLite (only 3 load on connect — the graph is NOT pre-loaded with the
library):
- "The Leprechaun" — Source=128 (Tidal)
- "24 Hr Sports" — Source=256 (Qobuz)
- "Fly or Die …" — Source=1 (Local) but ContentSource=128 (Tidal)

Full Album via `GetAlbum(long AlbumId)`:
- "24 Hr Sports" (Qobuz): **ImportDate=2026-08-15T13:19:59Z**, `QobuzAlbumId=28699336`,
  PerformedBy="El Michels Affair" → a newly-added Qobuz album.
- "The Leprechaun" (Tidal): ImportDate=2022-05-19, `TidalAlbumId=59814`.
- "Fly or Die …": ImportDate=2023-09-08, `TidalAlbumId=13975974` (local file, also on Tidal).

DateTime is `.NET DateTime.FromBinary` (raw int64): mask off the top 2
DateTimeKind bits, then ticks→epoch: `ms = (ticks & 0x3FFFFFFFFFFFFFFF - 621355968000000000) / 10000`.

## Gotcha: AlbumLite `AlbumId` ≠ full-Album `AlbumId` for streaming albums

For streaming albums the **AlbumLite `AlbumId` is actually the service-specific
persistent id** (`QobuzAlbumId`/`TidalAlbumId`), while the full `Album`'s own
`AlbumId` is a different internal id. So:
- `GetAlbum(long)` accepts the AlbumLite id (the service id) and returns the full
  Album;
- but the pushed full Album must be matched as the **last-pushed Album object**
  (its `AlbumId` field won't equal the AlbumLite id).

This trap breaks naive id-matching between AlbumLite and Album.

## Verdict

- **No field literally named `Service`, `added`/`DateAdded`, or `IsStreamable`
  exists** on any of the four entity types — the extension-API fields are absent
  from the internal protocol.
- **The semantic equivalents ARE present and populated**:
  - streaming service → `Source`/`ContentSource` (MediaSource: Tidal=128,
    Qobuz=256, Local=1) — populated on all pushed objects;
  - added date → `ImportDate` (all four types) — populated reliably on the **full
    Album** (streaming included);
  - streamable/downloadable → `IsDownloadSupported`, `IsPlayable`, `IsAvailable`;
  - service id → full Album `QobuzAlbumId`/`TidalAlbumId`/`KKBoxAlbumId`.
- Caveat: the connect graph holds only a handful of AlbumLite (not the whole
  library), and `ImportDate` is null on the *pushed lite* objects for pure-streaming
  items — so reliable detection fetches the **full Album** via `GetAlbum(long)`,
  which populates ImportDate + the service-specific id.

## Conclusion

The fields needed to identify a newly-added streaming album exist and are populated
on the full `Album` object: streaming service (`Source`/`ContentSource` →
MediaSource), added date (`ImportDate`), and the service-specific persistent id
(`QobuzAlbumId`/`TidalAlbumId`). A detector can harvest from the live graph by
watching pushed AlbumLite and fetching the full Album via `GetAlbum(long)` — no
named-field search (the FSEMessage/query subsystem) is required for this purpose.

No mutations were attempted during this probe (connect + read-only GetAlbum).
