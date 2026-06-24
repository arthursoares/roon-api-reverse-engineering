---
title: Calls & objects
description: How method calls, argument types, by-val struct arguments, and the object graph (pushes / responses) are encoded in the Roon remoting protocol.
sidebar:
  order: 3
---

How a method invocation is assembled and how the Core's replies and pushes are decoded.
Ported in `src/proto/{remoting,serializer,objects}.ts`.

## Method calls (`CALL`, cmd 3)

```
CALL body = flexLong(objectId) + flexInt(methodId) + args
```

- `objectId` — the **server-assigned** object you're calling on (from a `PUSHOBJ`, or a
  service resolved via `GETSVC`).
- `methodId` — a **client-assigned** integer. The *first* time you use one, the client
  auto-sends a `DEFMETHOD` (cmd 6) declaring it:

  ```
  DEFMETHOD = flexInt(methodId) + string(signature)
  ```

  The Core maps the id to a real method **by the signature string** — so you choose the
  ids; the server resolves them by name.

A response body is `string(status) + returnValue`. The status `"Success"` (and `""`) means
OK — `isSuccessStatus()` encapsulates that. A method with no callback parameter is
**fire-and-forget**: no request id, no response (`callMethodNoReply`).

## Method signature strings

```
Sooloos.Broker.Api.{Interface}::{Method}({fullyQualifiedArgTypes})
```

Type-name mapping (matched the 67 signatures I had captures to check against):

- Primitives keep the C# keyword: `string`, `bool`, `double`, `long`, `int`.
- `Sooid` → `System.Sooid`; `byte[]` → `System.Byte[]`.
- `ResultCallback` → `Base.ResultCallback` (keeps its generic, e.g.
  `ResultCallback<PlayFeedback>`).
- Collections → `System.Collections.Generic.*`.
- Everything else → `Sooloos.Broker.Api.{T}`.

Built by `formatMethodSignature()` in `src/catalog/signature.ts`.

## Argument encoding (`serializer.ts`)

Arguments are **positional**; each non-callback parameter is written in order by its kind:

| Param kind | Encoding |
|------------|----------|
| `Sooid` | `sooid(bytes)` |
| primitive | its primitive writer |
| `enum` | `flexInt(value)` |
| **by-ref object** (interfaces: `Zone`, `Album`, `Track`…) | `flexLong(objectId)` |
| **by-val struct** (`[ByVal]` classes: `PlayParameters`, `*QueryCriteria`…) | inline value object (below) |
| `IEnumerable<ref>` | `flexInt(count) + flexLong(oid)*` |
| `ResultCallback` | omitted from the wire |

### By-val struct arguments

A by-val struct is sent as an **inline value object**:

```
flexLong(1) + flexInt(clientTypeId) + flexInt(len) + sparseFields
```

You must declare the type once with `DEFTYPE` (cmd 5):

```
DEFTYPE = flexInt(typeId) + string(name) + flexInt(count)
          + [ string(memberName) + flexInt(propType) ] * count
```

The server matches members **by name**, so sending a **subset** (or none) is legal — you
only declare the fields you set. `RoonClient.structArg(typeName, fields)` does this for you;
`inlineStruct()` builds the bytes.

:::tip[Struct member naming]
For nested edit structs (e.g. `Library::Edit`), members are addressed by their **full**
name — `"<wireType> <FullTypeName>::<Member>"` — because the server matches against the
.NET `PropertyDescriptor.Name`. A nested struct is `Object`; an `IList<struct>` is
length-prefixed: `int(len) + flexInt(count) + inlineValueObject*`.
:::

## The object graph (responses & pushes)

The Core describes types, then streams objects. Decoded by `ObjectGraph` in
`src/proto/objects.ts`.

**Type definitions** (`DEFTYPE`, cmd 7 server-side):

```
flexInt(typeId) + string(name) + flexInt(count)
  + [ string(member) + flexInt(PropertyType) ] * count
```

**Object pushes** (`PUSHOBJ` / `UPDATEOBJ` / `PUSHSTUB`):

```
flexLong(oid) + flexInt(typeId) + fields
```

Fields are **sparse**:

```
( flexInt memberIndex (1-based), value )*  then  flexInt 0
```

Each `value` is read per that member's `PropertyType`. The `Object` property type is a
`flexLong`: `0` = null, `1` = an inline value object (`typeId, len, sparse fields`),
anything else = an object-id reference.

**Collections** (`DataList<T>` / `Query<T>`): no declared members; the body is `(1, count,
0)` followed by `count` items, each using the `Object` encoding above.

## Summary

| Concept | Who assigns | How referenced |
|---------|-------------|----------------|
| Method id | **Client** | declared once via `DEFMETHOD`, matched by signature |
| By-val type id | **Client** | declared once via `DEFTYPE`, matched by member name |
| Object id | **Server** | handed out via `PUSHOBJ`; ephemeral per session |

With these three encodings — calls, by-val structs, and the sparse object graph — the
entire 1550-method surface is reachable. The [generated client](/api/getting-started/)
builds all of it from the catalog automatically.
