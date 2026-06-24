# Investigation Plan: Roon API Authorization & Alternative Paths

## Context

The Roon API reverse engineering project has successfully decoded the binary protocol on port 9332, including the handshake, schema delivery, and message formats. However, all mutation/query operations are silently ignored despite successful connections. The blocker is **authorization** - the official Roon client authenticates with cloud servers before making local changes.

This plan outlines a structured investigation to either:
1. Crack the authorization mechanism
2. Find an alternative path via the extension API (port 9330)

---

## Phase 1: Extension API Deep Dive (Port 9330)

**Goal**: Determine if the public extension API can access favorites/library data without cloud auth.

### 1.1 Install and Study node-roon-api
```bash
cd roon-internal-api
npm install github:RoonLabs/node-roon-api
```

**Tasks**:
- [ ] Read the node-roon-api source code to understand MOO/1 protocol format
- [ ] Identify how it handles pairing/authorization
- [ ] Find what services it can access (browse, transport, etc.)

### 1.2 Create Working Extension Client
```bash
npx ts-node examples/extension-api-client.ts
```

**Tasks**:
- [ ] Build a minimal extension that pairs with Roon Core
- [ ] Subscribe to `com.roonlabs.browse:1` service
- [ ] Test if browse API can access "My Favorites" or similar

### 1.3 Compare Capabilities
**Tasks**:
- [ ] Document what extension API can do vs internal API
- [ ] Check if favorites are exposed through browse hierarchy
- [ ] Test if transport control works via extension API

**Expected Outcome**: Either find an alternative path to favorites, or confirm extension API has same limitations.

---

## Phase 2: HAR Capture Analysis

**Goal**: Understand the complete cloud authentication flow.

### 2.1 Parse HAR File
**File**: `captures/Roon_02-15-2026-00-36-22.har`

**Tasks**:
- [ ] Extract all cloud API calls in sequence
- [ ] Document the full auth flow (login → token → registration)
- [ ] Find what data is sent in `device-map/1/register`
- [ ] Check if there's a session linking mechanism

### 2.2 Identify Token Usage
**Tasks**:
- [ ] Search for where `roon_auth_token` is first obtained
- [ ] Check if token is sent in any binary protocol messages
- [ ] Look for correlation between cloud session and local broker ID

### 2.3 Replicate Cloud Flow
**Tasks**:
- [ ] Create script to replicate exact cloud API sequence
- [ ] Test if this enables local mutations
- [ ] Check timing requirements (does local need to happen during cloud session?)

**Expected Outcome**: Either find how to properly authenticate, or confirm cloud auth doesn't directly enable local mutations.

---

## Phase 3: Traffic Capture During Mutations

**Goal**: Capture exactly what the official client sends when favoriting an album.

### 3.1 Setup Capture Environment
```bash
# Find interface
ifconfig | grep -B5 "192.168"

# Start capture
sudo tcpdump -i en0 -w captures/mutation-capture.pcap host YOUR_CORE_IP
```

### 3.2 Capture Sequence
**Tasks**:
- [ ] Start capture before opening Roon client
- [ ] Capture the full initialization sequence
- [ ] Perform a favorite action in the UI
- [ ] Stop capture and analyze

### 3.3 Compare Packets
**Tasks**:
- [ ] Compare our ConnectRequest to official client's
- [ ] Look for any messages we're not sending
- [ ] Check if there's a session establishment step we're missing
- [ ] Identify any certificates or signatures

**Expected Outcome**: Find the missing piece in our protocol implementation.

---

## Phase 4: Unknown Ports Investigation

**Goal**: Determine purpose of ports 9150 and 9200.

### 4.1 Port 9150 Analysis
**Tasks**:
- [ ] Try different protocol probes (HTTP, raw binary, JSON)
- [ ] Check Roon logs for references to this port
- [ ] Look for SOOD (discovery) responses

### 4.2 Port 9200 Analysis
**Tasks**:
- [ ] Same probes as 9150
- [ ] Check if it's a streaming/media port
- [ ] Test with audio data packets

### 4.3 Document Findings
**Tasks**:
- [ ] Update ROON_INTERNAL_API.md with port purposes
- [ ] Determine if either port is relevant to auth

**Expected Outcome**: Either find these ports are irrelevant, or discover a new avenue.

---

## Phase 5: Alternative Authorization Approaches

**Goal**: Test remaining hypotheses if phases 1-4 don't succeed.

### 5.1 Broker ID Registration
**Hypothesis**: Client broker ID must be registered with cloud before local mutations work.

**Tasks**:
- [ ] Call cloud API with our broker ID before connecting locally
- [ ] Try registering via `device-map/1/register`

### 5.2 Certificate/Signature Analysis
**Hypothesis**: Messages may require cryptographic signatures.

**Tasks**:
- [ ] Look for public keys in schema or handshake
- [ ] Check if ConnectRequest has signature fields we're not filling
- [ ] Analyze if messages have HMAC or similar

### 5.3 Session Linking
**Hypothesis**: Cloud session must be active during local mutations.

**Tasks**:
- [ ] Keep cloud WebSocket open while making local calls
- [ ] Check if cloud pushes authorization to local broker

---

## Verification

After each phase, verify progress by:
1. Running `npx ts-node examples/query-favorites.ts` - does it return data?
2. Running `npx ts-node examples/test-transport.ts` - does play/pause work?
3. Checking if any new data appears in responses

---

## Priority Order

1. **Phase 1** (Extension API) - Fastest path, may bypass auth entirely
2. **Phase 3** (Traffic Capture) - Most likely to reveal missing piece
3. **Phase 2** (HAR Analysis) - Deeper understanding of auth flow
4. **Phase 5** (Alternative Approaches) - If nothing else works
5. **Phase 4** (Unknown Ports) - Lowest priority, likely irrelevant

---

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `examples/extension-api-client.ts` | Test extension API |
| `examples/analyze-har.ts` | Parse HAR capture |
| `examples/full-capture-test.ts` | Compare with official client |
| `docs/ROON_INTERNAL_API.md` | Update with findings |
| `CLAUDE.md` | Update current state |

---

## Success Criteria

The investigation succeeds when we can:
1. Query the list of favorite albums programmatically, OR
2. Execute a transport command (play/pause) successfully, OR
3. Document exactly why it's not possible and what would be needed
