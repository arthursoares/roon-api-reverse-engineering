# roon-internal-api

TypeScript client for Roon's internal binary protocol on port 9332.

**Status:** Early development - only `setFavorite` is implemented.

## Installation

```bash
npm install roon-internal-api
```

## Usage

```typescript
import { RoonInternalClient, sooidFromHex } from 'roon-internal-api';

const client = new RoonInternalClient({
  host: 'YOUR_CORE_IP', // Your Roon Core IP
  port: 9332,
  autoReconnect: true,
});

client.on('connected', () => console.log('Connected!'));
client.on('error', (err) => console.error('Error:', err));

await client.connect();

// Favorite a track (you need the Sooid from traffic capture)
const trackId = sooidFromHex('0102030405060708090a0b0c0d0e0f10');
await client.library.setFavorite(trackId, true);

await client.disconnect();
```

## Services

- **library** - Favorites (implemented), browsing, search (TODO)
- **transport** - Playback operations (TODO)
- **dsp** - DSP configuration (TODO)
- **playlists** - Playlist management (TODO)

## With node-roon-api

This library is designed to work alongside the official node-roon-api:

```typescript
import RoonApi from 'node-roon-api';
import { RoonInternalClient } from 'roon-internal-api';

const roon = new RoonApi({
  // ... config
  core_paired: async (core) => {
    const internal = new RoonInternalClient({
      host: core.moo.transport.host,
    });
    await internal.connect();
    // Use both APIs
  },
});

roon.start_discovery();
```

## Development

```bash
npm install
npm run build
npm test
```

## Protocol Documentation

See [ROON_INTERNAL_API.md](../docs/ROON_INTERNAL_API.md) for protocol details.
