# Roon Internal Client API - Reverse Engineering Notes

## Overview

The Roon desktop client uses a **different protocol** than the public extension API (node-roon-api). While extensions use the text-based MOO/1 protocol over WebSocket on port 9330, the native client uses a **custom binary serialization format** on port **9332**.

## Protocol Comparison

| Feature | Extension API (Public) | Client API (Internal) |
|---------|------------------------|----------------------|
| Port | 9330 | 9332 |
| Format | Text (MOO/1) | Binary (custom .NET serialization) |
| Transport | WebSocket | Raw TCP |
| Namespace | `com.roonlabs.*` | `Sooloos.Broker.Api.*` |

## Binary Format Structure

The internal protocol uses a custom serialization format with these characteristics:

### Message Header
- **Byte 0**: Message type
  - `0x41-0x4F` ('A'-'O'): Client requests
  - `0xC0`: Server responses
- **Byte 1**: Message/sequence ID
- **Byte 2+**: Payload

### Type Markers
- `0x81`: String field
- `0x82`: Object/struct definition
- `0x83`: Collection/array
- Length-prefixed strings (1 byte length + UTF-8 data)

### Embedded Type Information
Full .NET type names are embedded in messages:
```
Sooloos.Broker.Api.VirtualAlbumLiteQuery
Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.HistogramItem<Sooloos.Broker.Api.TagLite>>
```

---

## Connection Handshake Protocol (DISCOVERED!)

Before sending commands, the client must complete a handshake with the server.

### Handshake Sequence

| Step | Direction | Bytes | Description |
|------|-----------|-------|-------------|
| 1 | Client→Server | `ROON` + `01 04` + ServerBrokerID (16b) + ClientBrokerID (16b) | Client hello |
| 2 | Server→Client | `ROON` + `01 80` | Server acknowledgment |
| 3 | Client→Server | `ROON` + `01 02` | Protocol version request |
| 4 | Server→Client | `ROON` + `01 82` + SessionID (16b) | Session established |
| 5 | Client→Server | ConnectRequest message | Full connection request |
| 6 | Server→Client | ConnectResponse + schema data (~300KB) | Connection accepted |

### Step 1: Client Hello (38 bytes)
```
52 4f 4f 4e                 # "ROON" magic
01 04                       # Hello indicator
[16 bytes ServerBrokerID]   # Server's broker ID (from SOOD discovery)
[16 bytes ClientBrokerID]   # Random client broker ID
```

### Step 2: Server Ack (6 bytes)
```
52 4f 4f 4e                 # "ROON" magic
01 80                       # Acknowledgment
```

### Step 3: Protocol Request (6 bytes)
```
52 4f 4f 4e                 # "ROON" magic
01 02                       # Protocol version indicator
```

### Step 4: Session Established (22 bytes)
```
52 4f 4f 4e                 # "ROON" magic
01 82                       # Session indicator
[16 bytes SessionID]        # Session identifier
```

### Step 5: ConnectRequest Message
A `Sooloos.Msg.DistributedBroker.ConnectRequest` message containing:
- `ClientBrokerId`: 16-byte broker ID (same as in hello)
- `ClientBrokerName`: Machine name (e.g., "HQ-00452")
- `ProtocolVersion`: "28"
- `ProtocolHash`: "aaedd22e2e6e452231e74dd309ffb9d27a9751ed"
- `ClientBranch`: "production"

### Step 6: Server Response
Server sends:
1. `ConnectResponse` with broker info
2. `UpdatesChangedResponse` with version info
3. Schema definitions for all API types (~300KB)

After receiving the schema data, the client can send commands.

### Notes
- The ServerBrokerID is obtained via SOOD (UDP port 9003) discovery
- The client must wait to receive all schema data before sending commands
- Small keepalive packets (`41 XX 00`, `c0 XX 00`) may be exchanged during the connection

---

## Discovered Types (128 total)

### Core Data Types
| Type | Description |
|------|-------------|
| `Album`, `AlbumBase`, `AlbumLite` | Album representations |
| `Track`, `TrackBase`, `TrackLite` | Track representations |
| `Performer`, `PerformerBase`, `PerformerLite` | Artist/performer data |
| `Work`, `WorkBase`, `WorkLite` | Classical work data |
| `Playlist`, `PlaylistBase`, `PlaylistItem` | Playlist data |
| `Tag`, `TagBase`, `TagLite`, `TagItem` | Tag/label data |
| `Zone` | Playback zone |
| `Profile` | User profile |

### Query & Browser Types
| Type | Description |
|------|-------------|
| `AlbumQueryCriteria`, `TrackQueryCriteria` | Query filters |
| `PerformerQueryCriteria`, `WorkQueryCriteria` | Query filters |
| `AlbumBrowserSpec`, `TrackBrowserSpec` | Browser configuration |
| `AlbumBrowserFilter`, `TrackBrowserFilter` | Browser filters |
| `PerformerAlbumsBrowser`, `PerformerTracksBrowser` | Result browsers |
| `WorkAlbumsBrowser`, `WorkTracksBrowser` | Classical work browsers |
| `VirtualAlbumLiteQuery`, `VirtualPlaylistItemQuery` | Query results |
| `UnifiedSearchResults`, `SearchParameters` | Search functionality |

### DSP & Audio Processing Types
| Type | Description |
|------|-------------|
| `DspConfig` | DSP configuration container |
| `DspConfigItem` | Individual DSP module |
| `DspPreset`, `DspPresets` | DSP presets |
| `ParametricEqualizerItem` | Parametric EQ module |
| `ParametricEqualizerSpec` | EQ specification |
| `ParametricEqualizerBand` | Individual EQ band |
| `ParametricEqualizerPreset` | EQ presets |
| `ConvolutionItem` | Convolution/room correction |
| `HeadphoneEqItem` | Headphone EQ database |
| `HeadroomAdjustmentItem` | Headroom management |
| `SampleRateConversionItem` | Upsampling/DSD conversion |
| `SpeakerSetupItem` | Speaker configuration |
| `AudezePresetsItem`, `AudezeSpatializerItem` | Audeze integration |
| `SonarworksSRItem` | Sonarworks integration |
| `RadianceItem` | Radiance processing |

### Playback Types
| Type | Description |
|------|-------------|
| `PlayParameters` | Playback options |
| `PlayFeedback` | Playback result |
| `SwimParameters` | Roon Radio parameters |
| `SwimPriority` | Radio priority settings |
| `InsertionPoint` | Queue insertion point |

### Playlist Management
| Type | Description |
|------|-------------|
| `PlaylistImprover` | Playlist enhancement |
| `PlaylistImproverHelper` | Improvement utilities |
| `PlaylistInsertionResult` | Insert operation result |

### External Integrations
| Type | Description |
|------|-------------|
| `Songkick`, `SongkickArtistEvents` | Concert data |
| `NugsSong`, `NugsVenue` | nugs.net integration |

---

## Discovered API Methods

### Library Service

```csharp
// Album queries
Library::VirtualAlbumQuery(Sooid, AlbumQueryCriteria, VirtualQueryParameters, ResultCallback<VirtualAlbumLiteQuery>)

// Browsing
Library::BrowsePerformerAlbums(Profile, PerformerLite, AlbumBrowserSpec, ResultCallback<PerformerAlbumsBrowser>)
Library::BrowsePerformerTracks(Profile, PerformerLite, TrackBrowserSpec, ResultCallback<PerformerTracksBrowser>)
Library::BrowsePerformerWorks(Profile, PerformerLite, WorkBrowserSpec, ResultCallback<PerformerWorksBrowser>)
Library::BrowseWorkAlbums(Profile, WorkLite, AlbumBrowserSpec, ResultCallback<WorkAlbumsBrowser>)
Library::BrowseWorkTracks(Profile, WorkLite, TrackBrowserSpec, ResultCallback<WorkTracksBrowser>)

// Data retrieval
Library::GetPerformer(PerformerBase, ResultCallback<Performer>)
Library::GetWork(WorkBase, ResultCallback<Work>)
Library::GetTag(Profile, Sooid, ResultCallback<Tag>)

// OneBox (detail panels)
Library::GetOneBoxPerformerNewReleases(PerformerLite, Sooid, ResultCallback<DataList<AlbumWithExtras>>)
Library::GetOneBoxPerformerRecommendedAlbums(PerformerLite, Sooid, ResultCallback<PerformerRecommendedAlbums>)
Library::GetOneBoxSimilarPerformers(PerformerLite, Sooid, IList<string>, ResultCallback<DataList<PerformerWithExtras>>)
Library::GetOneBoxSimilarComposers(PerformerLite, Sooid, ResultCallback<DataList<PerformerWithExtras>>)
Library::GetOneBoxComposerTopPerformers(PerformerLite, Sooid, ResultCallback<DataList<PerformerWithExtras>>)
Library::GetOneBoxComposerTopConductors(PerformerLite, Sooid, ResultCallback<DataList<PerformerWithExtras>>)
Library::GetOneBoxComposerWorksByForm(PerformerLite, Sooid, ResultCallback<DataList<OneBox_WorksByForm>>)
Library::GetOneBoxWorkTopPerformers(WorkLite, Sooid, ResultCallback<DataList<PerformerWithExtras>>)
Library::GetOneBoxWorkTopConductors(WorkLite, Sooid, ResultCallback<DataList<PerformerWithExtras>>)
Library::GetOneBoxWorkTopEnsembles(WorkLite, Sooid, ResultCallback<DataList<PerformerWithExtras>>)

// Search
Library::UnifiedSearch(SearchParameters, ResultCallback<UnifiedSearchResults>)
Library::AddRecentSearch(Profile, string)
Library::SerializeTagItemQuery(TagItemQueryCriteria, ResultCallback<byte[]>)
```

### Transport Service

```csharp
// Playback
Transport::PlayAlbums(Zone, Sooid, PlayParameters, IEnumerable<AlbumBase>, bool, bool, ResultCallback<PlayFeedback>)
Transport::PlayPlaylist(Zone, Sooid, PlayParameters, Playlist, PlaylistItem, ResultCallback<PlayFeedback>)
Transport::PlayPlaylistItems(Zone, Sooid, PlayParameters, IEnumerable<PlaylistItem>, ResultCallback<PlayFeedback>)
Transport::PlayPlaylistItemQuery(Zone, Sooid, PlayParameters, Playlist, PlaylistItemQueryCriteria, ResultCallback<PlayFeedback>)

// Roon Radio
Transport::PlaySwim(Zone, Sooid, SwimParameters, ResultCallback<PlayFeedback>)

// Zone transfer
Transport::Transfer(Zone, Zone, ResultCallback)
```

### Playlists Service

```csharp
// Playlist management
Playlists::InsertPerformances(Playlist, IEnumerable<PerformanceBase>, InsertionPoint, PlaylistItem, ResultCallback<PlaylistInsertionResult>)
Playlists::MoveItem(Playlist, PlaylistItem, InsertionPoint, PlaylistItem, ResultCallback)
Playlists::ReleasePlaylistImprover(Playlist, ResultCallback)

// Item queries
Playlist::GetItems(Sooid, PlaylistItemQueryCriteria, ResultCallback<Query<PlaylistItem>>)
ExplicitTag::GetItems(TagItemQueryCriteria, ResultCallback<Query<TagItem>>)
```

### DSP Configuration (MUTATION METHODS!)

```csharp
// Enable/disable DSP modules
DspConfigItem::SetEnabled(bool, ResultCallback)

// Configure parametric EQ
ParametricEqualizerItem::SetSpec(ParametricEqualizerSpec, bool, ResultCallback)

// Get DSP config
AudioDeviceCommonConfig::GetDspConfig(ResultCallback<DspConfig>)
```

### Zone Control

```csharp
Zone::Previous()
```

---

## DSP Configuration Details

### DspConfig Properties
| Property | Type | Description |
|----------|------|-------------|
| `IsEnabled` | bool | DSP enabled |
| `AutoApply` | bool | Auto-apply changes |
| `IsApplyPending` | bool | Changes pending |
| `IsBypassFilters` | bool | Filters bypassed |
| `CanBypassFilters` | bool | Can bypass |
| `CanRestoreFilters` | bool | Can restore |
| `SupportsActivePreset` | bool | Preset support |
| `ActivePreset` | DspPreset | Current preset |
| `ActivePresetIsModified` | bool | Preset modified |
| `Items` | DataList<DspConfigItem> | DSP modules |
| `BeforeItems` | DataList<DspConfigItem> | Pre-processing |
| `AfterItems` | DataList<DspConfigItem> | Post-processing |
| `AddItemTypes` | DataList<string> | Available modules |
| `DspPresets` | DspPresets | Preset library |
| `ParametricEqualizerPresets` | ParametricEqualizerPresets | EQ presets |

### DspConfigItem Properties
| Property | Type | Description |
|----------|------|-------------|
| `IsEnabled` | bool | Module enabled |
| `SupportsSetEnabled` | bool | Can toggle |
| `SupportsRemove` | bool | Can remove |
| `ParametricEqualizer` | ParametricEqualizerItem | PEQ module |
| `Convolution` | ConvolutionItem | Convolution |
| `HeadroomAdjustment` | HeadroomAdjustmentItem | Headroom |
| `SampleRateConversion` | SampleRateConversionItem | SRC |
| `SpeakerSetup` | SpeakerSetupItem | Speakers |
| `OpenHeadphoneDatabase` | HeadphoneEqItem | Headphone EQ |
| `AudezePresets` | AudezePresetsItem | Audeze |
| `AudezeSpatializer` | AudezeSpatializerItem | Audeze spatial |
| `SonarworksSR` | SonarworksSRItem | Sonarworks |
| `Radiance` | RadianceItem | Radiance |
| `BS2B` | BS2BItem | Crossfeed |
| `PEQ` | PEQItem | Simple EQ |

### ParametricEqualizerBand Properties
| Property | Type | Description |
|----------|------|-------------|
| `IsEnabled` | bool | Band enabled |
| `Type` | string | Filter type |
| `Frequency` | double? | Center frequency |
| `GainDb` | double? | Gain in dB |
| `Q` | double? | Q factor |
| `Order` | int? | Filter order |

### Sample Rate Conversion
| Property | Type | Description |
|----------|------|-------------|
| `SampleRateConversionMode` | string | Conversion mode |
| `SRCFilterType` | string | Filter type |
| `DsdOutputRate` | int | DSD output rate |
| `DsdToPcmFilter` | string | DSD→PCM filter |
| `DsdToPcmGain` | double | DSD→PCM gain |
| `DSDModulator` | string | DSD modulator |
| `AllowDSDProcessing` | bool | Allow DSD |
| `ParallelDSDModulator` | bool | Parallel modulator |

---

## Roon Radio (Swim) Parameters

| Property | Type | Description |
|----------|------|-------------|
| `BrokerId` | Guid | Broker ID |
| `Priority` | SwimPriority | Radio priority |
| `LimitToSeed` | bool | Limit to seed |
| `LimitToLibrary` | bool | Library only |
| `PreplayTrackFromSeed` | bool | Preplay seed track |
| `UseLocalGenres` | bool? | Use local genres |
| `UseMetadataGenres` | bool? | Use metadata genres |
| `IncludeHidden` | bool? | Include hidden |
| `Genres` | IList<string> | Genre filter |
| `Labels` | IList<string> | Label filter |
| `Tags` | IList<TagBase> | Tag filter |
| `Albums` | IList<AlbumBase> | Seed albums |
| `Tracks` | IList<TrackBase> | Seed tracks |
| `Performers` | IList<PerformerBase> | Seed performers |
| `Composers` | IList<PerformerBase> | Seed composers |
| `Works` | IList<WorkBase> | Seed works |
| `Playlists` | IList<PlaylistBase> | Seed playlists |
| `Mixes` | IList<MixBase> | Seed mixes |
| `Performances` | IList<PerformanceBase> | Seed performances |
| `AlbumCriteria` | AlbumQueryCriteria | Album filter |
| `TrackCriteria` | TrackQueryCriteria | Track filter |
| `WorkCriteria` | WorkQueryCriteria | Work filter |
| `PerformerCriteria` | PerformerQueryCriteria | Performer filter |
| `ComposerCriteria` | PerformerQueryCriteria | Composer filter |

---

## Browser Filter Properties

### AlbumBrowserFilter / TrackBrowserFilter / WorkBrowserFilter
| Property | Type | Description |
|----------|------|-------------|
| `RequireIsFavorite` | bool | Only favorites |
| `ExcludeIsFavorite` | bool | Exclude favorites |

### FilterInfo (counts)
| Property | Type |
|----------|------|
| `IsFavoriteCount` | int |
| `IsNotFavoriteCount` | int |

---

## Query Criteria Fields

### Common Fields
| Field | Type | Description |
|-------|------|-------------|
| `Version` | int | API version |
| `UiLanguage` | string | UI language (e.g., "en") |
| `LanguagePreferences` | string[] | Preferred languages |
| `Ordering` | int | Sort order |
| `Direction` | int | Sort direction |
| `RandomSeed` | int | Random seed for shuffle |

### Filter Modes
| Field | Values | Description |
|-------|--------|-------------|
| `MainPerformersMode` | "And", "Or" | Combine main performers |
| `PerformersMode` | "And", "Or" | Combine performers |
| `ProductionMode` | "And", "Or" | Combine production |
| `ComposersMode` | "And", "Or" | Combine composers |
| `ConductorsMode` | "And", "Or" | Combine conductors |
| `LabelsMode` | "And", "Or" | Combine labels |
| `GenresMode` | "And", "Or" | Combine genres |
| `PeriodsMode` | "And", "Or" | Combine periods |

---

## Image URLs

Format: `broker:///image/{id}.__ROON_IMAGE_SIZE__.jpg`
- Size placeholder replaced with: 256, 512, etc.

---

## Protocol Flow Details

### Message Types (Discovered)

| Type | Direction | Description |
|------|-----------|-------------|
| `0x03` | Server→Client | Data/streaming updates |
| `0x05` | Server→Client | Notification/streaming updates (most frequent) |
| `0x06` | Client→Server | Method registration/lookup |
| `0x07` | Server→Client | Schema type definitions |
| `0x41` | Client→Server | Keepalive |
| `0x42` | Client→Server | Schema trigger (with profile GUID) |
| `0x43` | Client→Server | Method call (indexed) |
| `0x47` | Client→Server | Named method call (like ConnectRequest) |
| `0x80` | Server→Client | Response/acknowledgment |
| `0xC0` | Server→Client | Callback response |

### Schema Trigger (0x42)

After ConnectRequest, the client sends a schema trigger to receive type definitions:

```
42 02 10 [16-byte-profile-GUID]
```

- `42` = Schema trigger message type
- `02` = Message ID
- `10` = GUID/sooid type marker
- `[GUID]` = Profile GUID (e.g., `bcd36e8478a3e111b2725b4a6188709b`)

This triggers ~350-400KB of schema data delivery from the server.

### Method Registration (0x06)

Before calling indexed methods, the client registers them:

```
06 [callback-id] 84 54 [method-signature]
```

Example for FavoriteOrBan:
```
06 81 13 84 54 81 0f [Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)]
```

### Method Call (0x43)

```
43 [msg-id] [method-index-bytes] [type-marker] [parameters]
```

Example favorite command:
```
43 03 1b 2d 84 54 [19-byte-item-id] [param-bytes] 01
```

### Current Limitations

**Authorization Required**: Mutation methods (like FavoriteOrBan) require authorization that the official Roon client has but our custom client doesn't. The server silently ignores unauthorized commands.

### Authorization Discovery (2026-02-15)

From HAR capture of Roon client HTTPS traffic:

**Auth Token**: `REDACTED-AUTH-TOKEN`
- UUID format cookie sent to cloud endpoints
- Found in: `roon_auth_token` cookie

**Cloud API Endpoints**:
- `https://api.roonlabs.net/bits/1/q/` - Queue/command endpoint
- `https://api.roonlabs.net/device-map/1/register` - Device registration

**Hypothesis**: The official client authenticates with cloud servers first, which authorizes local binary protocol mutations.

### Possible Authorization Mechanisms

1. **Cloud-First Auth**: Client calls cloud API with auth token, then local mutations work
2. **Token in Binary Protocol**: Auth token might need to be included in ConnectRequest or a separate auth message
3. **Session Linking**: Cloud registration might link the broker ID to an authorized session

### Tested Operations (2026-02-15)

| Operation | Status | Notes |
|-----------|--------|-------|
| Connection handshake | ✅ Works | All 6 steps complete |
| Schema delivery | ✅ Works | ~360KB received |
| Streaming updates | ✅ Works | Device discovery, playback state |
| Library mutations | ❌ Ignored | FavoriteOrBan silently ignored |
| Transport control | ❌ Ignored | Zone::Pause, Zone::Previous silently ignored |

**Conclusion**: ALL control/mutation operations require authorization. Only read operations work without auth.

---

## Next Steps

### Completed
1. ✅ Identify internal protocol (port 9332, binary format)
2. ✅ Extract type information (217+ types from schema)
3. ✅ Document DSP configuration API
4. ✅ Document Roon Radio (Swim) parameters
5. ✅ Capture favorite operation (packet format decoded)
6. ✅ Document connection handshake protocol
7. ✅ Create TypeScript client skeleton (`roon-internal-api/`)
8. ✅ Complete handshake implementation (full sequence works)
9. ✅ Schema trigger and delivery (working)
10. ✅ **Auth token discovered**: `REDACTED-AUTH-TOKEN`
11. ✅ **Cloud endpoints found**: `api.roonlabs.net`

### In Progress
12. 🔄 Understand how auth token enables local mutations
13. 🔄 Test cloud-first authentication flow

### Planned
14. ⬜ Capture metadata edit operations
15. ⬜ Build complete binary protocol parser
16. ⬜ Implement authorized client flow

---

## Tools Used

- `tcpdump` - Packet capture
- `tshark` - Packet analysis
- Custom Python decoder (`tools/decode_roon.py`)

## Disclaimer

This documentation is for educational and interoperability purposes. Not affiliated with Roon Labs.

---

## Favorite/Unfavorite Operation (DISCOVERED!)

### Packet Structure

The favorite toggle is a simple binary command:

```
Offset  Value           Meaning
------  -------------   --------------------------
0x00    0x43            Message type (client request)
0x01    0xNN            Message ID (sequence number)
0x02    0x1B            Operation code (27 = favorite toggle?)
0x03    0x32            Unknown
0x04-05 0x84 0x54       Type marker
0x06-15 [16 bytes]      Sooid (item ID) - e.g., 0x123f0116...
0x16-18 0x83 fa a4      Parameter type marker
0x19    0x11/0x10       Boolean: 0x11=true (favorite), 0x10=false (unfavorite)
```

### Example Packets

**Set Favorite (true):**
```
43 15 1b 32 84 54 12 3f 01 16 20 27 27 3a 55 d6 
4b bf 4a 85 f3 35 41 0e 2f 83 fa a4 11 01
```

**Remove Favorite (false):**
```
43 0c 1b 32 84 54 12 3f 01 16 20 27 27 3a 55 d6 
4b bf 4a 85 f3 35 41 0e 2f 83 fa a4 10 01
```

### Server Response

Server responds with `c0 XX 08 07 53 75 63 63 65 73 73 ...` ("Success")

### Key Insight

The operation code `0x1B` (27) appears to be an index into a method table. The actual method name is not embedded in the packet - it's resolved by the server based on this index and the connection context.

