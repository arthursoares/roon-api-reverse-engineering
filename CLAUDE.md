# Claude Context

> **★ START HERE: `docs/plans/2026-06-11-MASTER-PLAN.md` ★**
> The project is **SOLVED** (no auth — protocol reverse-engineered from Roon's
> decompiled Mono assemblies). A working, test-covered TypeScript client lives in
> `roon-internal-api/` and is proven LIVE (favorite UI-confirmed, playback
> audio-confirmed). The MASTER-PLAN has the full protocol reference, current
> state, and the ordered plan to build ALL 1550 methods. Everything below this
> banner is historical context from before the breakthrough — defer to the
> MASTER-PLAN and `docs/plans/2026-06-11-{findings-auth-reframe,build-roadmap}.md`.
> Current goal: build the entire method surface into the typed API (see plan §5).

## Project Goal

Reverse engineer the Roon desktop client's internal API to discover undocumented functionality (metadata editing, library management, etc.) that isn't available in the public extension API.

## Key Discovery

The Roon client uses a **different protocol** than extensions:
- **Port 9332** (not 9330)
- **Binary format** (not text-based MOO/1)
- **Namespace**: `Sooloos.Broker.Api.*`

## Current State (2026-02-15)

### What Works
- [x] Identified internal protocol port and format
- [x] Extracted 217+ unique data types from schema
- [x] Documented connection handshake protocol (all 6 steps working)
- [x] **0x42 schema trigger** - triggers ~360KB schema delivery
- [x] Favorite packet format decoded from capture
- [x] **Full connection working**: Handshake + ConnectRequest + Schema delivery
- [x] **Read operations work**: Streaming updates (0x05), device discovery, schema
- [x] **Auth token discovered**: `REDACTED-AUTH-TOKEN` (from HAR capture)
- [x] **Cloud API endpoints found**: `api.roonlabs.net/bits/1/q/`, `device-map/1/register`
- [x] **Port scan complete**: 9150, 9200, 9330, 9332 all open

### What Doesn't Work
- [ ] **Mutation commands silently ignored** (no "MissingMethod", just no response)
- [ ] **Transport commands silently ignored** (play, pause, skip - tested 2026-02-15)
- [ ] **Query commands silently ignored** (VirtualAlbumQuery for favorites - tested)
- [ ] Reusing captured client broker ID → ECONNRESET (server tracks active sessions)
- [ ] Authorization mechanism not yet understood
- [ ] Cloud-then-local approach (cloud call succeeds, local still blocked)
- [ ] Extension API (port 9330) doesn't respond to MOO/1 requests

### Key Finding (2026-02-15)
**ALL control operations require authorization**, not just library mutations:
- Library mutations (favorites): ❌ Silently ignored
- Transport control (play/pause/skip): ❌ Silently ignored
- Library queries (VirtualAlbumQuery): ❌ Silently ignored
- Read operations (streaming, schema): ✅ Works

### Root Cause Analysis — REVISED 2026-06-11 (was likely wrong)
The earlier "needs cloud auth" theory is **not supported by the wire data**. See
`docs/plans/2026-06-11-findings-auth-reframe.md`. Key corrections:
- The local 9332 protocol carries **no** auth token/credential/signature/HMAC
  anywhere (scanned all 1,440 strings in the official client→core stream).
  The cloud token is never sent locally.
- Our packet format is correct: dispatch token `1b 2d` for FavoriteOrBan is
  **stable across sessions** (verified across two captures).
- The 4-byte field after the track id (`86 8e f2 47`) is a **session-specific
  ResultCallback handle**, not a fixed marker. `debug-flow.ts` hardcodes a stale
  one from `full-session.pcap`.
- A byte-perfect call (correct token + registration + format) is still dropped
  with **zero** server response (verified live via `examples/favorite-verify.ts`).

**RESOLVED — there is no local auth.** Two controlled captures
(`captures/known-fav.pcap`, `captures/from-start.pcap`) fully decode the favorite:
```
43 <msgid> 1a2e 8420 123f01162027273a55d64bbf4a85f335410e2f <TrackBase> <state>
  call id  cb   method  arg1=profile/context Sooid (CONSTANT)  arg2=track  0/1
```
Declared by `06 8113 8420 810f <FavoriteOrBan signature>` just before. The server
acts with NO ack and NO credential.

Key corrections to older notes:
- `123f...410e2f` is **NOT** the track — it's the profile/context `System.Sooid`
  arg 1 of nearly every Library method (600× in server stream). Constant per user.
- The **TrackBase** is the bytes AFTER the Sooid and is an **ephemeral session
  handle** (`a0c301` for "Coisa Maluca" vs `a18c67` for "desde que o samba"),
  assigned by the server when it lists the track. NOT a persistent id.
- `1a 2e`/`84 20` (callback/method handles) are declared via `06` registration;
  deterministic per client install (`.88` used `1b 2d`/`84 54`).

Our calls were dropped because we hardcoded handles from a DEAD session. Favoriting
is **browse-then-mutate**: query to get a track's ephemeral handle, then call
FavoriteOrBan. Fix = implement registration + query + handle extraction, NOT cloud
auth. See `docs/plans/2026-06-11-findings-auth-reframe.md`.

### Port Analysis (2026-02-15)
| Port | Protocol | Status |
|------|----------|--------|
| 9150 | Unknown | Open, no response to probes |
| 9200 | Unknown | Open, closes on ROON magic |
| 9330 | WebSocket/MOO/1 | WebSocket connects on `/api`, doesn't respond to MOO/1 |
| 9332 | Binary/Sooloos | Our main focus, works for reads, auth required for writes |

### Approaches Attempted for Favorites
1. **Direct query** (VirtualAlbumQuery with RequireIsFavorite) - silently ignored
2. **Using captured broker ID** - works when real client closed, queries still ignored
3. **Cloud API first, then local** - cloud succeeds (200 OK, 10KB response), local still blocked
4. **Port 9330 extension API** - WebSocket connects but MOO/1 requests get no response

## Connection Handshake (Complete!)

```
1. Client: ROON + 0104 + ServerBrokerID + ClientBrokerID (38 bytes)
2. Server: ROON + 0180 (6 bytes) - ack
3. Client: ROON + 0102 (6 bytes) - protocol request
4. Server: ROON + 0182 + SessionID (22 bytes) - session established
5. Client: ConnectRequest message (235-241 bytes)
6. Server: ConnectResponse + UpdatesChangedResponse (436 bytes)
7. Client: 0x42 Schema Trigger (19 bytes) ← KEY DISCOVERY
8. Server: Schema data (~360KB with 217 Sooloos types)
```

## 0x42 Schema Trigger Message

This is the critical message that triggers schema delivery:

```
42 02 10 bc d3 6e 84 78 a3 e1 11 b2 72 5b 4a 61 88 70 9b
│  │  │  └─────────────────────────────────────────────┘
│  │  │                16-byte Profile GUID
│  │  └─ Length prefix (0x10 = 16)
│  └─ Message ID
└─ Message type (schema/subscription)
```

**Important**: The profile GUID `bcd36e84-78a3-e111-b272-5b4a6188709b` is from the captured session. Using this GUID triggers schema delivery, but the favorite command still returns "MissingMethod" - suggesting the method indices may be session/profile-specific.

## Favorite Packet Format (Verified from Capture)

```
43 XX 1b 2d 84 54 [19-byte itemId] 86 87 93 0f [00/01]
│  │  │  │  │  │                   │           └─ 01=favorite, 00=unfavorite
│  │  │  │  │  │                   └─ Parameter marker
│  │  │  │  │  └─ Type marker (T for Track?)
│  │  │  │  └─ Type indicator (0x84)
│  │  │  └─ Sub-opcode (0x2d = 45)
│  │  └─ Method index (0x1b = 27)
│  └─ Message ID
└─ Message type (command)

Example: 43 20 1b 2d 84 54 12 3f 01 16 20 27 27 3a 55 d6 4b bf 4a 85 f3 35 41 0e 2f 86 87 93 0f 01
```

## Method Registration (0x06 Messages)

The real Roon client sends `0x06` messages to register method callbacks before calling them. Example methods registered:
- `Sooloos.Broker.Api.Messaging::GetMessages`
- `Sooloos.Broker.Api.Library::GetAlbum`
- `Sooloos.Broker.Api.Library::GetPerformer`
- `Sooloos.Broker.Api.Library::DeserializeTrackQuery`

**Note**: No `SetFavorite` method was seen in the registration messages. Favorites might use a different mechanism (direct property mutation?).

## Authorization Discovery (2026-02-15)

### Cloud Authentication
From HAR capture (`captures/Roon_02-15-2026-00-36-22.har`):

**Auth Token**: `REDACTED-AUTH-TOKEN`
- UUID format
- Set as cookie: `roon_auth_token=REDACTED-AUTH-TOKEN`
- Sent to cloud endpoints with every request

**Cloud API Endpoints**:
```
https://api.roonlabs.net/bits/1/q/            # Queue/command endpoint
https://api.roonlabs.net/device-map/1/register # Device registration
```

**Token Storage Locations**:
- `~/Library/Roon/Cache/sessions/*/000003.log` (LevelDB format)
- `~/Library/Roon/Logs/Roon_log.txt` (grep for auth_token)

### Key Insight
The auth flow likely involves:
1. Client authenticates with cloud (`api.roonlabs.net`)
2. Gets/validates `roon_auth_token`
3. Token authorizes local binary protocol mutations

### Testing Needed
- Make cloud API calls with auth token FIRST
- Then attempt local binary protocol mutation
- Or: find how token is used in binary protocol

## Message Types

| Type | Name | Description |
|------|------|-------------|
| 0x06 | Register Method | Subscribe to method callback |
| 0x41 | Keepalive | Sent every ~5s, response: 0xc0 XX 00 |
| 0x42 | Schema/Subscribe | Triggers schema delivery with profile GUID |
| 0x43 | Command | Execute method by index |
| 0x47 | Named Method | Call method by full type name |
| 0x80 | Complex Response | Multi-field response |
| 0xc0 | Simple Response | Ack or error |

## Files

### Documentation
- `docs/ROON_INTERNAL_API.md` - Main API documentation (protocol, types, methods)
- `docs/CAPTURE_GUIDE.md` - How to capture traffic
- `docs/plans/2026-02-03-roon-internal-api-design.md` - Library design doc

### TypeScript Library
- `roon-internal-api/` - Client library (in progress)
  - `src/connection.ts` - TCP connection management
  - `src/protocol/encoder.ts` - Binary message encoding
  - `src/protocol/decoder.ts` - Binary message decoding
  - `examples/` - 48 test scripts (see `examples/README.md`)

### Captures
- `captures/fresh-favorite.pcap` - Working favorite commands (mid-session)
- `captures/full-init2.pcap` - Full initialization with schema (653KB)
- `captures/full-session.pcap` - Complete session capture (2.8MB)
- `captures/Roon_02-15-2026-00-36-22.har` - **HTTPS capture with auth token**

## Test Scripts

```bash
cd roon-internal-api

# Working - read-only operations
npx ts-node examples/debug-flow.ts          # Full connection debug (WORKING)
npx ts-node examples/read-state.ts          # Read streaming updates (WORKING)
npx ts-node examples/collect-schema.ts      # Collect schema to /tmp (WORKING)
npx ts-node examples/find-zone-id.ts        # Find zone IDs from stream (WORKING)

# Commands - connects but silently ignored (auth required)
npx ts-node examples/test-transport.ts      # Test play/pause/skip (IGNORED)
npx ts-node examples/favorite-working.ts    # Attempt favorite (IGNORED)
npx ts-node examples/query-with-token.ts    # Query with captured broker ID (IGNORED)
npx ts-node examples/cloud-then-local.ts    # Cloud API then local query (IGNORED)

# Favorites query attempts (all silently ignored)
npx ts-node examples/get-favorites.ts       # Basic favorites extraction
npx ts-node examples/query-favorites.ts     # VirtualAlbumQuery approach
npx ts-node examples/query-with-auth-field.ts # With auth field in ConnectRequest

# Port 9330 / Extension API tests
npx ts-node examples/scan-roon-ports.ts     # Scan all Roon ports (9150,9200,9330,9332)
npx ts-node examples/test-port-9330-ws.ts   # WebSocket test (connects, no response)
npx ts-node examples/test-all-ports.ts      # Comprehensive port testing
```

## User's Roon Setup

- Core IP: `YOUR_CORE_IP`
- Core API Port: `9332`
- Server Broker ID: `YOUR_SERVER_BROKER_ID`
- Local machine: `YOUR_MACHINE_IP` (or via Tailscale: 10.x.x.x, interface feth2324)
- **Office Zone Sooid**: `YOUR_ZONE_SOOID`
- **Office Output ID**: `YOUR_OUTPUT_ID:roon_YOUR_OUTPUT_GUID_Office`

## Next Steps

### Priority 1: Extension API (Port 9330)
**Status**: WebSocket connects but MOO/1 requests don't get responses
1. Install `node-roon-api` from GitHub: `npm install github:RoonLabs/node-roon-api`
2. Use it to understand correct MOO/1 protocol format
3. The extension API might allow browse/favorites without cloud auth
4. Test files created: `examples/test-port-9330*.ts`

### Priority 2: Investigate Ports 9150 and 9200
These ports are open but their purpose is unknown:
- Port 9150: No response to SOOD, ROON, HTTP, or JSON probes
- Port 9200: Closes connection after receiving data
- May be used for different services (discovery, streaming?)

### Priority 3: Deep Protocol Analysis
1. Capture traffic while official client accesses favorites
2. Compare binary requests - maybe favorites query needs specific parameters
3. Look for session establishment messages we're missing

### Tried and Failed
- ❌ Cloud API first, then local mutation (cloud works, local still blocked)
- ❌ Using captured broker ID (works when client closed, queries still blocked)
- ❌ Adding auth token to ConnectRequest fields
- ❌ Direct MOO/1 requests to port 9330 WebSocket

## How to Capture Traffic

```bash
# Find correct interface (if using Tailscale)
ifconfig | grep -B5 "10.147"

# Capture on correct interface
sudo tcpdump -i feth2324 -w captures/new.pcap port 9332

# Or for direct network
sudo tcpdump -i en0 -w captures/new.pcap host YOUR_CORE_IP and port 9332
```
