# Signature-drift fixtures

Synthetic inputs for `tools/check_signatures.ts --self-test`. Each directory
holds a hand-written `dump.json` (the `tools/dump_broker_api.py` format, a few
invented types — no data from a real Roon.Broker.Api.dll), a `wire.json`
standing in for the SDK's wire names, and `expected.json` with the exact drift
set and the bindings the checker must report.

| Fixture | Exercises |
|---|---|
| `namespace-rename` | metadata in `Roon.Broker.Api.*`, wire in `Sooloos.Broker.Api.*`: no drift, alias note |
| `missing-member` | a real parameter change, a removed member, a removed type and a `Roon.*` wire spelling, all under the renamed namespace |
| `inherited-retainpage` | `RetainPage` declared on the generic base `VirtualQuery\`2` binds under the derived interface with substituted parameters; `IDisposable.Dispose` binds through the BCL table; the same method name on an unrelated type is a hint, never a match |
| `generics` | closed wire types (`EditList<string>`) checked against open definitions with `T` substituted; arity mismatch; BCL `IList<T>` members on an open generic |
