# Roon Internal API Client - Design Document

**Date:** 2026-02-03
**Status:** Approved

## Overview

A TypeScript library (`roon-internal-api`) that provides access to Roon's internal binary protocol on port 9332, enabling functionality not available in the public extension API.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript/Node.js | Aligns with existing node-roon-api ecosystem |
| Architecture | Companion library | Clean separation, no fork maintenance burden |
| API Style | Service-based | Mirrors internal Sooloos structure, easy to extend |
| Connection | Auto-managed with events | Handles reconnection, matches node-roon-api behavior |

## Architecture

```
roon-internal-api/
├── src/
│   ├── client.ts           # Main RoonInternalClient class
│   ├── connection.ts       # TCP connection + reconnection logic
│   ├── protocol/
│   │   ├── encoder.ts      # Encode requests to binary format
│   │   ├── decoder.ts      # Decode responses from binary
│   │   └── types.ts        # Sooid, message types, markers
│   ├── services/
│   │   ├── library.ts      # Library service (favorites, browsing)
│   │   ├── transport.ts    # Transport service (playback)
│   │   ├── dsp.ts          # DSP configuration
│   │   └── playlists.ts    # Playlist management
│   └── index.ts            # Public exports
├── package.json
└── tsconfig.json
```

## Components

### Connection Layer

```typescript
class RoonConnection extends EventEmitter {
  private socket: net.Socket | null;
  private messageId: number = 0;
  private pendingRequests: Map<number, { resolve, reject, timeout }>;

  constructor(
    private host: string,
    private port: number = 9332,
    private options: { autoReconnect: boolean, reconnectDelay: number }
  ) {}

  async connect(): Promise<void>;
  async disconnect(): Promise<void>;
  async send(opCode: number, payload: Buffer): Promise<Buffer>;

  // Events: 'connected', 'disconnected', 'error'
}
```

### Protocol Layer

**Request Format:**
```
Offset  Value           Meaning
------  -------------   --------------------------
0x00    0x43            Message type (client request)
0x01    0xNN            Message ID (sequence number)
0x02    0xNN            Operation code (method index)
0x03    0x32            Unknown marker
0x04-05 0x84 0x54       Type marker
0x06+   [varies]        Sooid + parameters
```

**Core Types:**
```typescript
type Sooid = Buffer;  // 16-byte item identifier

interface RoonRequest {
  type: 0x43;
  messageId: number;
  opCode: number;
  payload: Buffer;
}

function encodeRequest(opCode: number, sooid: Sooid, params: Buffer): Buffer;
function decodeResponse(data: Buffer): { messageId: number, success: boolean, data?: any };
```

### Main Client

```typescript
class RoonInternalClient extends EventEmitter {
  private connection: RoonConnection;

  readonly library: LibraryService;
  readonly transport: TransportService;
  readonly dsp: DspService;
  readonly playlists: PlaylistsService;

  constructor(host: string, port?: number, options?: ClientOptions);

  async connect(): Promise<void>;
  async disconnect(): Promise<void>;
  get isConnected(): boolean;

  // Events: 'connected', 'disconnected', 'error'
}
```

### Services

**LibraryService:**
```typescript
class LibraryService {
  async setFavorite(itemId: Sooid, favorite: boolean): Promise<void>;
  async browseAlbums(criteria: AlbumQueryCriteria): Promise<AlbumResult[]>;
  async browsePerformerAlbums(performerId: Sooid): Promise<AlbumResult[]>;
  async search(query: string, params?: SearchParams): Promise<SearchResults>;
}
```

**DspService:**
```typescript
class DspService {
  async getConfig(zoneId: Sooid): Promise<DspConfig>;
  async setItemEnabled(zoneId: Sooid, itemIndex: number, enabled: boolean): Promise<void>;
  async setParametricEq(zoneId: Sooid, spec: ParametricEqSpec): Promise<void>;
}
```

**TransportService:**
```typescript
class TransportService {
  async playAlbums(zoneId: Sooid, albumIds: Sooid[]): Promise<PlayFeedback>;
  async playSwim(zoneId: Sooid, params: SwimParameters): Promise<PlayFeedback>;
  async transfer(fromZone: Sooid, toZone: Sooid): Promise<void>;
}
```

**PlaylistsService:**
```typescript
class PlaylistsService {
  async insertPerformances(playlistId: Sooid, items: Sooid[], position: InsertionPoint): Promise<void>;
  async moveItem(playlistId: Sooid, itemId: Sooid, position: InsertionPoint): Promise<void>;
}
```

## Usage Examples

### With node-roon-api (recommended)

```typescript
import RoonApi from "node-roon-api";
import { RoonInternalClient } from "roon-internal-api";

const roon = new RoonApi({
  extension_id: "com.example.my-extension",
  display_name: "My Extension",
  display_version: "1.0.0",
  publisher: "Me",
  core_paired: async (core) => {
    const internal = new RoonInternalClient({
      host: core.moo.transport.host,
      autoReconnect: true,
    });

    internal.on("connected", () => console.log("Internal API ready"));
    await internal.connect();

    // Use internal API
    await internal.library.setFavorite(trackId, true);
    await internal.dsp.setItemEnabled(zoneId, 0, true);
  },
});

roon.start_discovery();
```

### Standalone

```typescript
import { RoonInternalClient } from "roon-internal-api";

const client = new RoonInternalClient({
  host: "YOUR_CORE_IP",
  port: 9332,
});

await client.connect();
await client.library.setFavorite(trackId, true);
```

## Error Handling

```typescript
class RoonInternalError extends Error {
  constructor(message: string, public code?: string) {}
}

class ConnectionError extends RoonInternalError {}
class TimeoutError extends RoonInternalError {}
class ProtocolError extends RoonInternalError {}
class OperationError extends RoonInternalError {}
```

## Testing Strategy

1. **Unit tests** - Mock connection, test encoder/decoder with captured byte sequences
2. **Integration tests** - Against real Roon Core (manual setup required)
3. **Captured data tests** - Replay pcap data to verify parsing

## Implementation Phases

### Phase 1: Core Infrastructure ✓
- [x] Project setup (TypeScript, ESLint, Jest)
- [x] Connection class with auto-reconnect
- [x] Basic encoder/decoder for known packet formats
- [x] Client class skeleton

### Phase 2: Library Service (partial)
- [x] setFavorite (we have the packet format)
- [ ] Basic browsing methods
- [ ] Search

### Phase 3: Additional Services
- [ ] DSP configuration
- [ ] Transport/playback
- [ ] Playlists

### Phase 4: Polish (partial)
- [x] Comprehensive types
- [x] Documentation (basic README)
- [x] Examples
- [ ] npm package setup (publish to npm)

## Open Questions

1. **Authentication** - Does port 9332 require any token, or does it trust connections from paired clients?
2. **Method discovery** - How to map more operation codes to method names?
3. **Subscription model** - How do server-push updates work in this protocol?

## References

- [ROON_INTERNAL_API.md](../ROON_INTERNAL_API.md) - Protocol documentation
- [Favorite operation packet format](../ROON_INTERNAL_API.md#favoriteunfavorite-operation-discovered)
- Captures in `/captures/` directory
