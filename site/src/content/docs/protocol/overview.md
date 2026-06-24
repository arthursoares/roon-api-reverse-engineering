---
title: Protocol overview
description: A map of the Sooloos.Broker.Remoting protocol — ports, handshake, message types, and where each detail is documented.
sidebar:
  order: 1
---

These are working notes on **`Sooloos.Broker.Remoting`**, the binary protocol Roon's desktop
client uses to talk to a Core on **TCP port 9332**. It's my best current understanding from
reading the decompiled `Roon.Broker.Remoting.dll` and checking it against my own packet
captures — not an official spec, and probably wrong in places.

:::note[Where this comes from]
The reference C# is `RemotingClientV2`, `RemotingUtils`, `TypeMappingHelper`, and
`PropertyMapping` in the shipped `Roon.Broker.Remoting.dll`. The TypeScript port tries to
mirror them under `roon-internal-api/src/proto/`.
:::

## Ports

| Port | Protocol | Use |
|------|----------|-----|
| 9330 | MOO/1 (text) over WebSocket | Public **extension** API (`node-roon-api`) — sandboxed |
| **9332** | **Binary `Sooloos.Broker.Remoting`** | What the desktop client uses — the subject of this reference |
| 9100/9150/9200 | misc | discovery / streaming; not used here |

## Connection lifecycle

```
1. Client → ROON + 0104 + ServerBrokerId + ClientBrokerId   (handshake)
2. Server → ROON + 0180                                       (ack)
3. Client → ROON + 0102                                       (protocol request)
4. Server → ROON + 0182 + SessionId                           (session established)
5. Client → ConnectRequest                                    (transport setup)
6. Server → ConnectResponse + UpdatesChangedResponse
7. Client → GETSVC for the root service (by stable GUID)
8. Server → pushes the object graph; streaming updates begin
```

The `ROON`-prefixed handshake and the `ConnectRequest` transport live in
`src/proto/connection.ts`. After the handshake, every message is a **remoting frame** (see
[Wire format](/protocol/wire-format/)).

## Message types (commands)

Requests and responses share a one-byte command; bit `0x80` marks a response, bit `0x40`
on a request means "expects a response" (a request id follows).

| Cmd | Name | Direction | Meaning |
|-----|------|-----------|---------|
| 1 | `PING` | ↔ | keepalive |
| 2 | `GETSVC` | C→S | resolve a service object by GUID |
| 3 | `CALL` | C→S | invoke a method on an object |
| 4 | `GCOBJS` | C→S | release object references |
| 5 | `DEFTYPE` | C→S | declare a client-side by-val type |
| 6 | `DEFMETHOD` | C→S | declare a method signature → id mapping |
| 7 | `SENDMSG` | C→S | send a message-typed payload |

Server→client pushes reuse the low nibble: `PUSHOBJ`=3, `PUSHSTUB`=4, `UPDATEOBJ`=5,
`FLUSH`=6, `DEFTYPE`=7, `DEFEVENT`=8, `EVENT`=2, `FLUSHRESUME`=9.

## The mental model

Three ideas explain almost everything:

1. **Method ids are client-assigned; object ids are server-assigned.** You pick a small
   integer for each method signature and declare the mapping once (`DEFMETHOD`). The Core
   hands you object ids when it pushes objects (`PUSHOBJ`).
2. **Object references are ephemeral session handles**, not persistent identifiers. You
   must obtain a live object (by reading the graph or querying) before you can call methods
   against it. This is the insight that unblocked all mutations — see
   [the journey](/journey/).
3. **There doesn't appear to be authentication** on the local protocol. In my testing a
   correctly-formed call against a live handle just works — no token, no signature. (Caveat:
   one Core, one network. Don't take it as a guarantee.)

## Where to go next

- **[Wire format](/protocol/wire-format/)** — framing, varints, and primitive encodings.
- **[Calls & objects](/protocol/calls-and-objects/)** — how method calls, by-val struct
  arguments, and the object graph (responses/pushes) are encoded.
