/**
 * roon-internal-api — a faithful TypeScript port of Roon's internal remoting
 * protocol (Sooloos.Broker.Remoting), reverse-engineered from the decompiled
 * desktop assemblies. Proven live against a real Roon core: read the object
 * graph, favorite (UI-confirmed), play (audio-confirmed), transport, standby.
 */

// High-level facade — start here.
export { RoonClient, RoonClientOptions } from './proto/client';

// Transport + remoting layer.
export { RoonConnection, ConnectionOptions } from './proto/connection';
export { RemotingClient, Cmd, CallResult, isSuccessStatus, Transport } from './proto/remoting';

// Framing + serialization primitives.
export { Frame, FrameParser, encodeRequest, encodeResponse } from './proto/frame';
export { BinaryWriter } from './proto/writer';
export { BinaryReader } from './proto/reader';
export { writeFlexInt, readFlexInt, writeFlexLong, readFlexLong } from './proto/flex';

// Argument serialization.
export { Arg, buildArgs, inlineStruct } from './proto/serializer';

// Object graph (response deserialization).
export { ObjectGraph, PropertyType, RoonObject, ObjRef, isRef, TypeDef, TypeMember } from './proto/objects';

// Catalog + signatures (the full method/type map lives in catalog.authoritative.json).
export { formatMethodSignature, formatType, CatalogParam } from './catalog/signature';

// Generated typed API: all 1550 methods as one class per service.
//   const api = makeApi(roonClient); await api.library.favoriteOrBan(...);
// Entity classes (ZoneApi, EndpointApi, AlbumApi…) take an explicit object id.
export { makeApi } from './generated/api';
export * as generated from './generated/api';
