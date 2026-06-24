---
title: How this went
description: The actual path of the investigation — a wrong theory about auth, reading the decompiled client, and confirming there's no local auth.
sidebar:
  order: 1
  label: How this went
---

This is a fairly honest log of how the experiment went, wrong turns included — because the
wrong turns are the useful part if you're poking at something similar. None of it is
authoritative; it's "what I found in my setup." Most of the grind (decoding, porting, these
notes) was done pair-programming with Claude.

## The setup: two protocols

Roon ships a public **extension API** (`node-roon-api`): a text protocol (MOO/1) over a
WebSocket on **port 9330**, deliberately sandboxed. It can't edit metadata or manage the
library the way the desktop app does.

Watching the desktop client with a packet sniffer, it mostly ignores 9330 and talks to the
Core on **port 9332** instead — a *binary* protocol in the `Sooloos.Broker.Api.*` namespace
(*Sooloos* was the product's name before it became Roon). That looked like the interesting
target, so that's where the poking went.

The **read** side came together fairly quickly:

- The connection handshake (the `ROON` magic, a broker-id exchange, a session id).
- A `0x42` "schema trigger" message that makes the Core stream a few hundred KB describing
  200+ types.
- Live streaming updates: zones, devices, now-playing — all readable.

## The wall: writes silently ignored

Then it stalled. **Favorites, transport (play/pause/skip), queries** — all silently
dropped. No error, no `MissingMethod`, no ack. Just nothing back.

The obvious guess, given Roon's cloud login, was **authorization**:

> Reads are free; mutations need a cloud-issued auth token. Log in to the cloud, grab the
> token, and *then* the local protocol unlocks.

A real auth token was even visible in an HTTPS capture. I tried the lot:
cloud-call-then-local, stuffing the token into the `ConnectRequest`, reusing a captured
broker id. The cloud calls returned 200 OK; the local writes stayed dead. For a while this
felt like a dead end.

:::note[Why the wall was misread]
On this protocol, a *malformed* call and an *unauthorized* call look identical — both
produce zero response. With no error channel, "ignored" got read as "rejected for lack of
auth" when it more likely just meant "you sent stale/garbage handles." That conflation is
what sent things down the auth rabbit hole.
:::

## The reframe: there doesn't seem to be local auth

Going back over the raw bytes more carefully knocked the auth theory down:

- Scanning *all* the strings in the official client→Core stream turned up no token,
  credential, signature, or HMAC anywhere. The cloud token never appears on the local wire.
- The packet format I'd reconstructed was actually fine — the method-dispatch token for the
  favorite call was **stable across two separate sessions**.

So why were correctly-formed calls still dropped? Because I was replaying **dead handles**.
Two things had been misread:

1. A long, constant blob I'd assumed was "the track" is actually the **profile/context
   identifier** — argument 1 of nearly every `Library` method (it shows up hundreds of times
   in the stream). It's constant per user and has nothing to do with the track.
2. The real track reference is an **ephemeral, session-scoped object handle** the Core hands
   out when it lists the track — *not* a persistent id. Replaying one from an old capture
   points at nothing in the current session, so the call gets dropped.

The conclusion that reframed the whole thing:

:::tip[It's browse-then-mutate, not authenticate-then-mutate]
You don't need a token. You need to **ask the Core for a live object first** (which gives
you its current handle), then call the mutation against *that* handle. The missing piece was
an object model, not a credential.
:::

I later re-checked this with a couple of clean captures: the favorite call fully decodes,
and the Core acts on it with no ack and no credential in sight. (Caveat: this is what I see
on my LAN against my Core. I can't promise it generalizes.)

## The shortcut: the client isn't obfuscated

The thing that actually unblocked it was to stop guessing from bytes and **read the source**.
Roon's desktop app is built on Mono, and the assemblies that ship with it are
**unobfuscated**. Decompiling them (with `ilspycmd`) turned reverse-engineering into more of
a porting job:

- Classes like `RemotingClientV2` and `RemotingUtils` spell out the exact framing, varint
  scheme, primitive encodings, and call convention.
- The protocol's internal name is `Sooloos.Broker.Remoting`.
- The full method surface — a few hundred services, ~1550 methods, ~100 enums — is
  extractable straight from the type metadata with a tiny C# reflection tool.

From there it became a TypeScript port, cross-checked against my captures. See the
[protocol notes](/protocol/overview/) for the result.

## What I actually got working

With the object model right, a handful of things worked when I tried them by hand against my
own Core (each confirmed once or twice — not a regression suite):

- **Favorite** an album → showed up in the Roon UI.
- **Play an album** on a zone → audio came out of the speakers.
- **Pause**, **standby/power** → fire-and-forget calls that took effect.
- **Metadata editing** (`Library::Edit`) — set a rating/title, read it back, restore it.
  This was the original motivation: a thing the public API just can't do.

Then, for breadth, a code generator reads the extracted catalog and emits typed wrappers for
**all ~1550 methods**. Important caveat: "generated and type-checks" is a long way from
"works." The encoding for the few paths above is checked against captures; the rest is
correct-by-construction at best and untested at worst.

## Where it stands

| | |
|---|---|
| Protocol | Mapped well enough to drive a Core (in my setup) |
| Methods | All ~1550 generated + typed; only a handful exercised live |
| Tried by hand | read, favorite, play, transport, standby/power, a metadata edit |
| Checks | a small test suite passes; `tsc` clean |
| Biggest open piece | full streaming-catalog search (in-library search half-works) |

The most visible unfinished bit is **search over the streaming catalog** (arbitrary
Tidal/Qobuz terms). The call format looks right and the Core *does* return results, but it
delivers them through a lazy, reactive sequence of per-section follow-up queries that I
haven't fully pinned down. That's probably the best-scoped thing to
[help with](/contributing/).

## Notes to self (and fellow tinkerers)

- **No error channel ≠ rejection.** When a protocol drops bad input silently, "ignored" is
  ambiguous. Don't over-fit a security story onto what might be a formatting bug.
- **Captures lie about lifetime.** A field that's constant *within* a session can be
  *ephemeral across* sessions. Sort persistent ids from session handles early.
- **Look for the source before brute-forcing bytes.** An unobfuscated client turns
  reverse-engineering into porting.
- **"Compiles" isn't "works."** A method that type-checks and round-trips can still be wrong
  on the wire. The only claims worth trusting are the ones backed by a capture match or a
  visible live effect.
