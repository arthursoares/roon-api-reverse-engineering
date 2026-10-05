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

### Signature drift after a Roon update

The Core silently ignores a method signature or struct member name it does not know, so a
Roon update that moves one makes a call quietly do nothing. `tools/check_signatures.ts`
compares every wire name the SDK can send (generated and handwritten, extracted from the
TypeScript source) with a metadata dump of the installed `Roon.Broker.Api.dll`, and checks
the SDK against the committed catalog:

```bash
pip install dnfile
python3 tools/dump_broker_api.py --dll /path/to/Roon.Broker.Api.dll --out /tmp/broker-api.json
npm run check:signatures -- --dump /tmp/broker-api.json
npm run check:signatures -- --catalog-only   # SDK vs committed catalog, no DLL
npm run check:signatures -- --self-test      # synthetic fixtures (run in CI)
```

On macOS the DLL is `/Applications/Roon.app/Contents/MonoBundle/Roon.Broker.Api.dll`.
Exit 1 means drift (`METHOD_DRIFT`, `MEMBER_DRIFT`, `TYPE_DRIFT`, each with a source
location and the closest DLL names) or an SDK/catalog mismatch; exit 2 means unreadable,
invalid or foreign input. Only the metadata-side `Roon.Broker.Api.` → `Sooloos.Broker.Api.`
alias (#15) is normalized, with a printed `NAMESPACE_ALIAS` count. Inherited interface
methods and generic instantiations are bound explicitly and reported. Dumps are derived
from proprietary software: keep them out of the repository.

## Protocol Documentation

See [ROON_INTERNAL_API.md](../docs/ROON_INTERNAL_API.md) for protocol details.
