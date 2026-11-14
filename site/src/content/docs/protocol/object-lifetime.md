---
title: Object lifetime
description: How long the Core keeps the objects it pushes to a client, how the official client releases them, and the release rules a third-party client should follow.
sidebar:
  order: 4
---

Every object the Core pushes to a client stays referenced **on the Core** until that client
says it is done with it or disconnects. Roon Labs warns that misusing this protocol "can
easily cause memory or compute leaks in the Roon Core". Object lifetime is the part of that
warning a client controls directly. This page covers what the Core holds, how the official
client releases it, and the rules this SDK follows.

Evidence: member names from the installed `Roon.Broker.Remoting.dll` and
`Roon.Broker.Api.dll` (re-checked on Core 2.73 build 1696, where the namespaces read
`Roon.Broker.Remoting.*`), plus read-only live probes. The `GCOBJS` wire layout and its
client and server handling come from static analysis of the shipped
`Roon.Broker.Remoting.dll` in Roon 2.74 build 1716 (SHA-256 `201f8288…e6779`), recorded in
[#32](https://github.com/arthursoares/roon-api-reverse-engineering/issues/32#issuecomment-6665634695).
The method tokens and IL offsets cited below are build-local. Nothing on this page needs a
write to the Core.

## What the Core holds

The server side of a connection (`RemotingServerV2`) keeps per-connection remote-object
tables, including `_remote_objs`, that hold a strong reference to **every object it has
pushed to that client**, keyed by object id. Entries leave the tables in only two ways:

- **The client releases them** with `SERVERCMD_GCOBJS` (cmd 4). `RemotingServerV2.OnGcObjs`
  unbinds each known object, removes it from both tables, and **cancels any outstanding
  calls bound to that object id** (see [The `GCOBJS` message](#the-gcobjs-message)).
- **The connection closes.** `_DiscardHeldObjects` (`0x06000109`) walks both tables, calls
  `ReclaimHeldObject` on each entry, clears them, and cancels outstanding calls. Un-released
  objects don't survive until a Core restart. Reclamation depends on each object's owner and
  type, though, and has explicit failure and missing-owner paths. Treat disconnect as the
  fallback release, not as a guaranteed equivalent of `GCOBJS`.

`Cmd.GCOBJS` is defined in `src/proto/remoting.ts`, but **this SDK never sends it**. On a
long-lived connection, both the Core's `_remote_objs` and the client's `ObjectGraph` grow
without bound.

## How the official client releases

The official client (`RemotingClientV2`) holds each proxy through a `System.WeakReference`
(`ObjectProxyDescriptor`). A timer (`_compactTableTimer`, scheduled alongside `_KeepAlive`)
runs `_CompactTable()`, which scans those weak references, drops the ids of proxies the .NET
GC has collected, and reports them to the Core in a batched `GCOBJS` message.

### The `GCOBJS` message

`_CompactTable` (`0x060000ae`, IL_00b3–00bd) sends cmd 4 **without a request id**, so it
expects no reply. The body is a count followed by that many object ids:

```text
[0x04] [flexInt bodyLength] [flexInt count] [flexLong oid] × count
```

`RemotingServerV2.OnGcObjs` (`0x060000e3`) reads the same layout. For each id it unbinds the
object (IL_0031), removes it from both remote-object tables (IL_0037–004a), and cancels the
outstanding calls bound to that id (IL_0052). It sends an empty final acknowledgment only if
the frame carried a request id (IL_0076).

:::note[Why captures don't show it]
Releases depend on the client's GC, so a traffic capture shows `GCOBJS` only if it spans a
client collection plus a compaction tick. Most short captures contain none, which makes the
verb easy to miss. The layout above comes from the shipped client and server code, not from
a capture. A capture of the official client releasing objects would still corroborate it.
:::

## Pushed once per connection

The Core pushes each object to a connection **once**. When a later call returns an object
the connection already holds, the Core sends only its id. A same-session example: a second
`GetAlbum` that referenced an `AlbumLite` the connection already had pushed no new
`AlbumLite`, only fresh `DataList`s. Consequences:

- **Never attribute results by graph diff** ("objects that are new since the call"). A
  repeated or overlapping call surfaces nothing new. A UnifiedSearch issued twice on one
  connection returns its full result set by membership both times, but a graph diff
  collects every hit the first time and **none** the second. Read results from the call's
  own returned object (see `RoonClient.search`).
- **The client's graph only grows** while the connection is open. Nothing is evicted, and
  nothing tells the Core it may forget.

## Paged queries: `RetainPage` / `ReleasePage`

`Virtual*Query` objects are refcounted per page: `RetainPage(int)` makes a page's items
live, and `ReleasePage(int)` gives them back. The protocol has three quirks here:

- **Use the derived declaring type.** Both methods resolve only under the concrete query
  type, e.g. `VirtualAlbumLiteQuery::ReleasePage(int, Base.ResultCallback)` or
  `VirtualHistoryPlayQuery::…`. The base-type name (`Sooloos.Broker.Api.VirtualQuery::ReleasePage`)
  gets `MissingMethod`. The catalog lists it under the open generic
  ``VirtualQuery`2``; call it under the concrete type.
- **Don't wait for a reply.** The Core executes `ReleasePage` but never invokes its
  `ResultCallback`, so an awaited call times out even though the release happened. Send it
  with `callMethodNoReply`. The official client uses its callback-less
  `CallMethod(long, int, byte[])` overload the same way.
- **Release exactly once per successful retain, and never retry.** Over-releasing corrupts
  the Core's page refcounts, which is worse than leaking a page. A lost or skipped release
  is reaped on disconnect anyway. Release in a `finally` so a failed harvest still gives the
  page back.

`src/history-export.ts` follows all three rules. It also sends the query's own `Dispose()`
without waiting. The Core's handling of `Dispose()` hasn't been verified, but the query is
reaped on disconnect regardless.

Related server-side lifetime hooks in the catalog that this SDK doesn't use:
`RefCountedQuery::Dispose`, `QueryView::Dispose`, `Broker::GCCollect()`.

## Rules for a client

1. **Prefer short-lived connections:** connect, do the work, close. The disconnect is
   then the release. It is a fallback rather than a precise release, but it is the only one
   this SDK has exercised end to end. Don't cache one `RoonClient` across unrelated operations.
2. **A long-lived connection needs an ownership model before it sends `GCOBJS`.** The wire
   layout is known; which ids are safe to release is not. A released id may be a returned
   root, an object shared with another operation's results, the backing of a retained page
   or a subscription, or the target of a pending call, which the Core cancels. Define
   explicit ownership and pinning for those cases. Test batched release, shared references,
   ordering, repeated browse/release cycles and call cancellation offline before any bounded
   live validation. Don't simply release every object a completed search pulled in, and
   don't replace the strong object map with weak references. Event mapping
   ([#36](https://github.com/arthursoares/roon-api-reverse-engineering/issues/36)) and
   timeout handling ([#38](https://github.com/arthursoares/roon-api-reverse-engineering/issues/38))
   have to fit the same model.
3. **Pair every successful `RetainPage` with exactly one fire-and-forget `ReleasePage`** on
   the derived type, in a `finally`.
4. **Attribute results by membership, never by graph diff.**

Long-lived standing state can borrow patterns from Roon's public extension API
(`node-roon-api`): paired subscribe/unsubscribe keys, reaping keyed by connection, request
entries deleted on completion, a heartbeat, and bounded standing views.
