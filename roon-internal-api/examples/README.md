# Roon Internal API Examples

## Working Examples (Read-Only)

### `debug-flow.ts`
**Status: WORKING**

Complete debug flow showing the full connection sequence:
1. Handshake (ROON magic exchange)
2. ConnectRequest/Response
3. Schema trigger (0x42)
4. Method registration (0x06)
5. Command sending (0x43)

```bash
npx ts-node examples/debug-flow.ts
```

Output shows all protocol exchanges with detailed byte-level logging.

### `read-state.ts`
**Status: WORKING**

Reads current state from Roon using streaming updates:
- Device discovery (AirPlay, Chromecast, zones)
- Playback state updates
- Network device information

```bash
npx ts-node examples/read-state.ts
```

Demonstrates that read operations work without authorization.

### `collect-schema.ts`
**Status: WORKING**

Connects to Roon server and collects schema data (~350KB).

```bash
npx ts-node examples/collect-schema.ts
```

Saves schema to `/tmp/roon-schema.bin` for analysis.

### `simple-query.ts`
**Status: WORKING**

Analyzes ConnectResponse and counts message types received.

```bash
npx ts-node examples/simple-query.ts
```

### `find-zone-id.ts`
**Status: WORKING**

Finds zone IDs from streaming updates. Useful for getting the sooid needed for transport commands.

```bash
npx ts-node examples/find-zone-id.ts
```

## Control Commands (Auth Required)

### `test-transport.ts`
**Status: CONNECTS BUT COMMAND IGNORED**

Tests transport control commands (Zone::Pause, Zone::Previous). Commands are silently ignored - confirms transport also requires auth.

```bash
npx ts-node examples/test-transport.ts
```

## Partially Working (Auth Experiments)

### `test-with-auth.ts`
**Status: EXPERIMENTAL**

Tests connection using captured auth credentials from HAR capture:
- Uses captured client broker ID
- Includes auth token reference

**Result**: ECONNRESET - server rejects when broker ID is already in use.

### `favorite-working.ts`
**Status: CONNECTS BUT COMMAND IGNORED**

Attempts the full favorite flow. Connection succeeds, schema arrives, but the favorite command is silently ignored (no response).

## Current Limitation

**Authorization Issue**: ALL control operations require authorization - not just library mutations, but also transport control (play/pause/skip). The official Roon client authenticates with cloud servers (`api.roonlabs.net`) before these work.

**Discovered Auth Token**: `REDACTED-AUTH-TOKEN` (from HAR capture)

**What works without auth**: Connection, schema delivery, streaming updates (read-only)
**What requires auth**: Library mutations (favorites), transport control (play/pause/skip)

## Protocol Summary

| Step | Message | Direction | Status |
|------|---------|-----------|--------|
| 1 | ROON + 0104 (Hello) | Client→Server | ✅ Working |
| 2 | ROON + 0180 (Ack) | Server→Client | ✅ Working |
| 3 | ROON + 0102 (Protocol) | Client→Server | ✅ Working |
| 4 | ROON + 0182 (Session) | Server→Client | ✅ Working |
| 5 | ConnectRequest (0x47) | Client→Server | ✅ Working |
| 6 | ConnectResponse (0x80) | Server→Client | ✅ Working |
| 7 | Schema Trigger (0x42) | Client→Server | ✅ Working |
| 8 | Schema Data (0x03,0x05,0x07) | Server→Client | ✅ Working |
| 9 | Method Reg (0x06) | Client→Server | ⚠️ Sent, no ack |
| 10 | Method Call (0x43) | Client→Server | ❌ Silently ignored |

## Next Steps

1. Make cloud API calls (`api.roonlabs.net`) with auth token before local mutations
2. Find where auth token is used in binary protocol
3. Check for pairing/registration step we're missing
