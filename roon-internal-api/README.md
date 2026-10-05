# roon-internal-api

TypeScript client for Roon's internal binary protocol on port 9332.

**Status:** Proof-of-concept. `RoonClient` and the generated API surface are exported, but
only a small subset has been exercised against a live Core.

## Installation

```bash
git clone https://github.com/arthursoares/roon-api-reverse-engineering
cd roon-api-reverse-engineering/roon-internal-api
npm install
```

`roon-internal-api` is not published to npm; use it from a clone.

## Usage

```typescript
import { RoonClient } from './src';

async function main(): Promise<void> {
  const host = process.env.ROON_HOST;
  const brokerId = process.env.ROON_SERVER_BROKER_ID;
  if (!host || !brokerId || !/^[0-9a-f]{32}$/i.test(brokerId)) {
    throw new Error('Set ROON_HOST and ROON_SERVER_BROKER_ID (32 hex characters)');
  }

  const roon = new RoonClient({
    host,
    serverBrokerId: Buffer.from(brokerId, 'hex'),
  });

  try {
    await roon.connect();
    console.log('Library oid:', roon.serviceOid('Library').toString());
    console.log('Zone oid:', roon.zoneByName('Living Room')?.toString());
  } finally {
    roon.close();
  }
}

main().catch(console.error);
```

The included read-only demo uses the same validated configuration:

```bash
ROON_HOST=192.168.1.50 ROON_SERVER_BROKER_ID=0123456789abcdef0123456789abcdef \
  npx ts-node examples/demo.ts
```

`ROON_BROKER_ID` is accepted as a legacy alias by the demo, but new scripts should use
`ROON_SERVER_BROKER_ID`.

## Services

`RoonClient` exposes the connection lifecycle and graph helpers. `makeApi(roon)` exposes
generated service wrappers. Both can cause real Core actions when you invoke mutating methods;
see the site recipes and the examples index before using them.

## Development

```bash
npm install
npm run build
npm test
```

## Protocol Documentation

See [ROON_INTERNAL_API.md](../docs/ROON_INTERNAL_API.md) for protocol details.

Before keeping a connection open across operations, read
[Object lifetime](../site/src/content/docs/protocol/object-lifetime.md): the Core holds
every object it pushes until the client releases it or disconnects, and this SDK never sends
the release verb (`GCOBJS`). Short-lived connections are the verified release path.
