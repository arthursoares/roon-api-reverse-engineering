---
title: Wire format
description: Frame structure, big-endian base-128 varints, and the primitive type encodings of the Roon remoting protocol.
sidebar:
  order: 2
---

The byte-level encoding, ported from `RemotingUtils`. Implemented in
`src/proto/{frame,flex,writer,reader}.ts`.

## Framing

Every post-handshake message is a frame:

```
[cmd byte] [flexInt requestId  — only if cmd has 0x40] [flexInt bodyLength] [body]
```

- `cmd` low 6 bits = the command (see [overview](/protocol/overview/)).
- `0x80` set → this frame is a **response**. On a response, `0x40` means **isFinal**.
- `0x40` set on a **request** → the call **expects a response**, and a `requestId`
  (flexInt) immediately follows. Fire-and-forget calls omit both the bit and the id.

`src/proto/frame.ts` provides `encodeRequest`, `encodeResponse`, and a streaming
`FrameParser`.

## Varints (`flex.ts`)

Integers are **big-endian base-128** with a continuation bit (`0x80`) on every byte except
the last. Two widths:

| Helper | Width | Used for |
|--------|-------|----------|
| `flexInt` | 32-bit | lengths, method ids, enum values, type ids |
| `flexLong` | 64-bit | object ids |

`WriteInteger` in the original is `flexInt`, so a length of `-1` (used to mean "null") is
encoded as the uint32 `0xFFFFFFFF`.

```ts
import { writeFlexInt, readFlexInt, writeFlexLong, readFlexLong } from 'roon-internal-api';
```

## Primitive encodings

Ported in `writer.ts` / `reader.ts`:

| Type | Encoding |
|------|----------|
| `string` | `flexInt(byteLen) + utf8 bytes`; `null` → `flexInt(-1)` |
| `Sooid` | `flexInt(len) + raw bytes` |
| `bool` | 1 byte (`0`/`1`) |
| `guid` | 16 raw .NET-order bytes |
| `double` / `float` | little-endian IEEE-754 |
| `byte[]` | `flexInt(len) + raw bytes` |
| `enum` | `flexInt(value)` |

### Optionals (nullable values)

| Form | Encoding |
|------|----------|
| `int? long? double? float? char? guid?` | `bool present` then the value if present |
| `bool?` | one byte: `0` = false, `1` = true, `2` = null |
| `Sooid?` | `flexInt(len)`, with `-1` meaning null |

:::caution[Known gap]
In the generated wrappers, *top-level nullable args* (`sooid?`, `prim:X?`) currently use the
base (non-optional) encoding — `null` becomes `0`/empty rather than the proper optional wire
form. This only affects methods that take nullable scalars directly; struct members are
handled correctly. Tracked in the build roadmap.
:::

## A worked example — the favorite call

The single call that broke the project open, fully decoded:

```
43 <msgid> 1a2e 8420 12<18-byte profile Sooid> <TrackBase handle> <state byte>
│  │       │    │    │                          │                  └ 0 = un-favorite, 1 = favorite
│  │       │    │    │                          └ arg 2: the track's *ephemeral* object handle
│  │       │    │    └ arg 1: profile/context System.Sooid (constant per user)
│  │       │    └ method handle
│  │       └ callback handle
│  └ request id
└ CALL (cmd 3, with response bit)
```

The two lessons baked into this one packet: the long constant blob is the **profile Sooid**
(not the track), and the track is referenced by an **ephemeral session handle** you must
obtain live first. See [the journey](/journey/) for why that mattered so much.
