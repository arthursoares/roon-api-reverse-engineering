/**
 * RoonClient — high-level facade over the ported remoting stack.
 *
 * Consolidates connection + remoting + object graph + service lookup so a PoC is
 * a few lines. The generic `call()` plus the typed helpers (favorite, play,
 * pause, standby, query-by-title) all run against the live core and are proven
 * end-to-end (favorite UI-confirmed, playback audio-confirmed).
 *
 *   const roon = new RoonClient({ host: 'YOUR_CORE_IP', serverBrokerId });
 *   await roon.connect();
 *   const album = roon.findByTitle('AlbumLite', 'Clube Da Esquina');
 *   await roon.favoriteAlbum(roon.albumIdOf(album!)!, true);
 *   await roon.playAlbumOnZone('HiFi', album!.oid);
 */
import { RoonConnection } from './connection';
import { RemotingClient, CallResult } from './remoting';
import { ObjectGraph, RoonObject, isRef, PropertyType } from './objects';
import { formatMethodSignature, CatalogParam } from '../catalog/signature';
import { Arg, buildArgs, inlineStruct } from './serializer';
import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';
import { readFlexLong } from './flex';

/** A field for a populated by-value struct argument. */
export interface StructField {
  name: string;
  propType: PropertyType;
  value: Buffer;
}

export interface RoonClientOptions {
  host: string;
  port?: number;
  serverBrokerId: Buffer;
  /** profile Sooid (value bytes). Defaults to the Profile object the Core
   * pushes into the graph on connect — pass this only to pin a specific
   * profile on a multi-profile Core. */
  profileSooid?: Buffer;
  /** ms to wait for the object graph to settle after getService. */
  settleMs?: number;
}

// The root service guid (stable). getService(root) populates the object graph.
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

export class RoonClient {
  readonly conn: RoonConnection;
  readonly remoting: RemotingClient;
  readonly graph = new ObjectGraph();
  private readonly explicitProfile?: Buffer;
  private cachedProfile?: Buffer;
  private settleMs: number;

  constructor(opts: RoonClientOptions) {
    this.conn = new RoonConnection({ host: opts.host, port: opts.port, serverBrokerId: opts.serverBrokerId });
    this.remoting = new RemotingClient(this.conn);
    this.remoting.onPush = (f) => this.graph.ingest(f);
    this.explicitProfile = opts.profileSooid;
    this.settleMs = opts.settleMs ?? 2000;
  }

  /**
   * The profile Sooid used by the library calls: the explicit option when
   * given, else read from the Profile object in the graph (available after
   * connect()). The old hardcoded default was one specific Core's profile id —
   * on every other Core the server matched nothing against it, which is a big
   * part of why search returned no results.
   */
  profile(): Buffer {
    if (this.explicitProfile) return this.explicitProfile;
    if (this.cachedProfile) return this.cachedProfile;
    for (const o of this.graph.objects.values()) {
      if (!o.typeName.endsWith('.Profile')) continue;
      for (const [k, v] of Object.entries(o.fields)) {
        if (k.endsWith('::ProfileId') && Buffer.isBuffer(v)) {
          this.cachedProfile = v;
          return v;
        }
      }
    }
    throw new Error('no Profile object in the graph yet — connect() first, or pass profileSooid');
  }

  /** Connect, establish the remoting session, and load the object graph. */
  async connect(): Promise<void> {
    await this.conn.connect();
    await this.remoting.getService(ROOT_SERVICE_GUID);
    await new Promise((r) => setTimeout(r, this.settleMs));
  }

  close(): void {
    this.conn.close();
  }

  // --- object lookup ---

  serviceOid(name: string): bigint {
    const o = this.graph.findByType(name)[0];
    if (!o) throw new Error(`service object "${name}" not found`);
    return o.oid;
  }

  private strField(o: RoonObject, suffix: string): string | undefined {
    for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && typeof v === 'string') return v;
    return undefined;
  }

  /** Find a loaded object of a type by its Title/Name (case-insensitive). */
  findByTitle(typeName: string, title: string): RoonObject | undefined {
    return this.graph.findByType(typeName).find((o) => {
      const t = this.strField(o, '::Title') ?? this.strField(o, '::Name');
      return t?.toLowerCase() === title.toLowerCase();
    });
  }

  /** Resolve a zone object id by the name of one of its endpoints. */
  zoneByName(name: string): bigint | undefined {
    for (const e of this.graph.findByType('Endpoint')) {
      if (this.strField(e, '::Name')?.toLowerCase().includes(name.toLowerCase())) {
        for (const [k, v] of Object.entries(e.fields)) if (k.endsWith('::Zone') && isRef(v)) return (v as any).$ref;
      }
    }
    return undefined;
  }

  /** Resolve an endpoint object id by name. */
  endpointByName(name: string): bigint | undefined {
    const e = this.graph
      .findByType('Endpoint')
      .find((x) => this.strField(x, '::Name')?.toLowerCase().includes(name.toLowerCase()));
    return e?.oid;
  }

  // --- generic call ---

  /** Call a method by service + name + params + pre-built args; returns the result. */
  call(service: string, method: string, params: CatalogParam[], args: Buffer, objectId?: bigint): Promise<CallResult> {
    const sig = formatMethodSignature(service, method, params);
    return this.remoting.callMethod(objectId ?? this.serviceOid(service), sig, args);
  }

  /**
   * Build a populated by-value struct argument: declare the given members
   * (cmd 5 DEFTYPE, indices 1..N in order) and serialize them as an inline
   * value object. Use the SAME members for a given type within a session.
   */
  structArg(typeName: string, fields: StructField[]): Buffer {
    const typeId = this.remoting.defineType(
      typeName,
      fields.map((f) => ({ name: f.name, propType: f.propType }))
    );
    return inlineStruct(
      typeId,
      fields.map((f, i) => ({ index: i + 1, value: f.value }))
    );
  }

  /** ms to wait for UnifiedSearch result objects to stream into the graph. */
  private searchSettleMs = 2000;

  /**
   * Library::UnifiedSearch — library AND streaming-catalog results.
   *
   * Three fixes over the first cut, all from a capture diff against the
   * official client's search:
   * - SearchParameters members are declared with their FULL wire names
   *   ("string Sooloos.Broker.Api.SearchParameters::Terms", …). The server
   *   matches DEFTYPE members by name and silently DROPS unknown ones, so the
   *   short names meant every parameter (terms included) was discarded — the
   *   search ran empty and returned nothing.
   * - The profile id comes from the graph (see profile()) instead of a
   *   hardcoded Sooid that only ever existed on one Core.
   * - Results are the objects the server pushes in response (graph diff), not
   *   a title-substring scan of the whole graph: the server's matches don't
   *   necessarily contain the terms in their title ("beatles abbey" → "Abbey
   *   Road"), and a whole-graph scan resurfaces stale hits from earlier
   *   searches.
   */
  async search(terms: string, maxCount = 50): Promise<RoonObject[]> {
    const params = this.structArg('Sooloos.Broker.Api.SearchParameters', [
      {
        name: 'System.Sooid Sooloos.Broker.Api.SearchParameters::ProfileId',
        propType: PropertyType.Sooid,
        value: new BinaryWriter().sooid(this.profile()).toBuffer(),
      },
      {
        name: 'string Sooloos.Broker.Api.SearchParameters::Terms',
        propType: PropertyType.String,
        value: new BinaryWriter().string(terms).toBuffer(),
      },
      {
        name: 'int Sooloos.Broker.Api.SearchParameters::MaxCount',
        propType: PropertyType.Int,
        value: new BinaryWriter().integer(maxCount).toBuffer(),
      },
      {
        name: 'int Sooloos.Broker.Api.SearchParameters::MaxTopResultCount',
        propType: PropertyType.Int,
        value: new BinaryWriter().integer(20).toBuffer(),
      },
    ]);
    const before = new Set(this.graph.objects.keys());
    const res = await this.call(
      'Library',
      'UnifiedSearch',
      [
        { type: 'SearchParameters', name: 'p' },
        { type: 'ResultCallback<UnifiedSearchResults>', name: 'cb' },
      ],
      params,
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`UnifiedSearch failed: ${res.status}`);
    await new Promise((r) => setTimeout(r, this.searchSettleMs)); // results stream in
    const wanted = ['AlbumLite', 'TrackLite', 'PerformerLite', 'WorkLite'];
    const out: RoonObject[] = [];
    for (const [k, o] of this.graph.objects) {
      if (before.has(k)) continue;
      if (!wanted.some((w) => o.typeName.endsWith(w))) continue;
      out.push(o);
      if (out.length >= maxCount) break;
    }
    return out;
  }

  /** Best-effort display title for a result object. */
  titleOf(o: RoonObject): string {
    return this.strField(o, '::Title') ?? this.strField(o, '::Name') ?? '?';
  }

  /**
   * Search albums via VirtualAlbumQuery + RetainPage (the paged query path the
   * official client uses). Returns the AlbumLite objects on the first page.
   *   VirtualAlbumQuery(profile, criteria{TextFilter}, params{PageSize}) ->
   *   VirtualAlbumLiteQuery oid -> RetainPage(0) -> items push.
   */
  async searchAlbums(term: string, pageSize = 40): Promise<RoonObject[]> {
    const criteria = this.structArg('Sooloos.Broker.Api.AlbumQueryCriteria', [
      { name: 'UiLanguage', propType: PropertyType.String, value: new BinaryWriter().string('en').toBuffer() },
      { name: 'TextFilter', propType: PropertyType.String, value: new BinaryWriter().string(term).toBuffer() },
    ]);
    const params = this.structArg('Sooloos.Broker.Api.VirtualQueryParameters', [
      { name: 'PageSize', propType: PropertyType.Int, value: new BinaryWriter().integer(pageSize).toBuffer() },
    ]);
    const args = Buffer.concat([buildArgs([Arg.sooid(this.profile())]), criteria, params]);
    const res = await this.call(
      'Library',
      'VirtualAlbumQuery',
      [
        { type: 'Sooid', name: 'profileid' },
        { type: 'AlbumQueryCriteria', name: 'criteria' },
        { type: 'VirtualQueryParameters', name: 'queryparams' },
        { type: 'ResultCallback<VirtualAlbumLiteQuery>', name: 'cb' },
      ],
      args,
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`VirtualAlbumQuery failed: ${res.status}`);
    // payload = object reference to the VirtualAlbumLiteQuery (GetObject: flexlong oid)
    const [queryOid] = readFlexLong(Uint8Array.from(res.payload), 0);
    await new Promise((r) => setTimeout(r, 400));
    // RetainPage(0) loads the first page; items then push.
    await this.call(
      'VirtualAlbumLiteQuery',
      'RetainPage',
      [
        { type: 'int', name: 'pagen' },
        { type: 'ResultCallback', name: 'cb' },
      ],
      buildArgs([Arg.int(0)]),
      queryOid
    );
    await new Promise((r) => setTimeout(r, 1500));
    // Collect AlbumLite objects referenced by the query's page items.
    const q = this.graph.getObject(queryOid);
    const items: any[] = (q?.fields as any)?.$items || [];
    const out: RoonObject[] = [];
    for (const it of items) {
      const oid = isRef(it) ? it.$ref : undefined;
      const o = oid !== undefined ? this.graph.getObject(oid) : undefined;
      if (o && this.strField(o, '::Title')) out.push(o);
    }
    // Fallback: any AlbumLite whose title contains the term (in case items are inline).
    if (!out.length) {
      const needle = term.toLowerCase();
      for (const o of this.graph.findByType('AlbumLite')) {
        const t = this.strField(o, '::Title');
        if (t && t.toLowerCase().includes(needle)) out.push(o);
      }
    }
    return out;
  }

  // --- typed convenience methods (proven live) ---

  /** Serialize one AlbumBase as an inline AlbumLink value struct {AlbumId, Broker}. */
  private albumLink(albumId: bigint): Buffer {
    return this.structArg('Sooloos.Broker.Api.AlbumLink', [
      {
        name: 'long Sooloos.Broker.Api.AlbumLink::AlbumId',
        propType: PropertyType.Long,
        value: new BinaryWriter().long(albumId).toBuffer(),
      },
      {
        name: 'Sooloos.Broker.Api.Broker Sooloos.Broker.Api.AlbumLink::Broker',
        propType: PropertyType.Object,
        value: new BinaryWriter().long(this.serviceOid('Broker')).toBuffer(),
      },
    ]);
  }

  /**
   * Favorite/unfavorite an album (FavoriteBanState: None=0, Favorite=1, Ban=2).
   *
   * Takes the STABLE album id (albumIdOf), not a session oid. Uses the
   * IEnumerable<AlbumBase> overload the official client uses; each element is
   * an inline AlbumLink value struct {AlbumId, Broker}, and the collection is
   * length-prefixed (Arg.collection). Both facts came from a byte-for-byte
   * capture diff against the official client — the previous single-AlbumBase
   * call with a bare object ref was silently ignored, and encoding the
   * collection as a naive count+refs list stalls the Core.
   */
  favoriteAlbum(albumId: bigint, favorite: boolean): Promise<CallResult> {
    return this.call(
      'Library',
      'FavoriteOrBan',
      [
        { type: 'Sooid', name: 'profileid' },
        { type: 'IEnumerable<AlbumBase>', name: 'albums' },
        { type: 'FavoriteBanState', name: 'state' },
        { type: 'ResultCallback', name: 'cb' },
      ],
      buildArgs([
        Arg.sooid(this.profile()),
        Arg.collection([this.albumLink(albumId)]),
        Arg.enum_(favorite ? 1 : 0),
      ]),
      this.serviceOid('Library')
    );
  }

  /** Play an album on a zone (default PlayParameters). */
  async playAlbum(zoneOid: bigint, albumOid: bigint): Promise<CallResult> {
    const ppTypeId = this.remoting.defineType('Sooloos.Broker.Api.PlayParameters', []);
    const args = Buffer.concat([
      buildArgs([Arg.ref(zoneOid), Arg.sooid(this.profile())]),
      inlineStruct(ppTypeId),
      buildArgs([Arg.ref(albumOid), Arg.bool(false), Arg.bool(false)]),
    ]);
    return this.call(
      'Transport',
      'PlayAlbum',
      [
        { type: 'Zone', name: 'zone' },
        { type: 'Sooid', name: 'profileid' },
        { type: 'PlayParameters', name: 'parameters' },
        { type: 'AlbumBase', name: 'album' },
        { type: 'bool', name: 'favoritesonly' },
        { type: 'bool', name: 'includehidden' },
        { type: 'ResultCallback<PlayFeedback>', name: 'cb' },
      ],
      args,
      this.serviceOid('Transport')
    );
  }

  /** Play a single track on a zone (default PlayParameters). */
  async playTrack(zoneOid: bigint, trackOid: bigint): Promise<CallResult> {
    const ppTypeId = this.remoting.defineType('Sooloos.Broker.Api.PlayParameters', []);
    const args = Buffer.concat([
      buildArgs([Arg.ref(zoneOid), Arg.sooid(this.profile())]),
      inlineStruct(ppTypeId),
      buildArgs([Arg.ref(trackOid)]),
    ]);
    return this.call(
      'Transport',
      'PlayTrack',
      [
        { type: 'Zone', name: 'zone' },
        { type: 'Sooid', name: 'profileid' },
        { type: 'PlayParameters', name: 'parameters' },
        { type: 'TrackBase', name: 'track' },
        { type: 'ResultCallback<PlayFeedback>', name: 'cb' },
      ],
      args,
      this.serviceOid('Transport')
    );
  }

  /** Convenience: find an album by title and play it on a named zone. */
  async playAlbumOnZone(zoneName: string, albumTitle: string): Promise<CallResult> {
    const zone = this.zoneByName(zoneName);
    const album = this.findByTitle('AlbumLite', albumTitle) ?? this.findByTitle('Album', albumTitle);
    if (!zone) throw new Error(`zone "${zoneName}" not found`);
    if (!album) throw new Error(`album "${albumTitle}" not loaded`);
    return this.playAlbum(zone, album.oid);
  }

  /** Fire-and-forget zone transport control (Pause/Play/Stop/Next/Previous/...). */
  zoneControl(zoneOid: bigint, method: 'Pause' | 'Play' | 'PlayPause' | 'Stop' | 'Next' | 'Previous'): void {
    this.remoting.callMethodNoReply(zoneOid, formatMethodSignature('Zone', method, []), Buffer.alloc(0));
  }

  /** Power a device off (standby) — fire-and-forget on the endpoint. */
  standby(endpointOid: bigint): void {
    this.remoting.callMethodNoReply(endpointOid, formatMethodSignature('Endpoint', 'Standby', []), Buffer.alloc(0));
  }

  /** Power a device on (convenience switch) — expects a response. */
  powerOn(endpointOid: bigint): Promise<CallResult> {
    return this.remoting.callMethod(
      endpointOid,
      formatMethodSignature('Endpoint', 'ConvenienceSwitch', [{ type: 'ResultCallback', name: 'cb' }]),
      Buffer.alloc(0)
    );
  }

  // --- metadata editing: read side (Phase E) ---

  /**
   * Read an album's editable metadata via Library::GetAlbumEditInfo. The result
   * is returned by-value (an inline AlbumEditInfo struct of Edit*Info<T> wrappers,
   * NOT pushed into the graph), so we decode it from the response payload. Each
   * field exposes its effective `Value`/`Values` plus whether the user has a local
   * edit layer. Proven live (read-only, safe). See docs Phase E.
   */
  async getAlbumEditInfo(albumOid: bigint): Promise<AlbumEditInfo> {
    const res = await this.call(
      'Library',
      'GetAlbumEditInfo',
      [
        { type: 'AlbumBase', name: 'album' },
        { type: 'ResultCallback<AlbumEditInfo>', name: 'cb' },
      ],
      buildArgs([Arg.ref(albumOid)]),
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`GetAlbumEditInfo failed: ${res.status}`);
    const decoded = this.graph.decodeReturnValue(Uint8Array.from(res.payload));
    return parseAlbumEditInfo(decoded as Record<string, unknown>);
  }

  // --- metadata editing: write side (Phase E) ---

  /**
   * Edit an album's metadata via Library::Edit. **Proven live & reversible** for
   * title, rating, genres and labels (set then call again with the prior values to
   * restore). `albumId` is the AlbumLite::AlbumId long (see albumIdOf), NOT the oid.
   *
   * Encoding (validated against the live core): a LibraryEdit by-value struct whose
   * Albums is an IList<AlbumEdit> (LengthPrefixed: int(len)+flexInt(count)+items);
   * each AlbumEdit member uses a nested Edit*<T> wrapper (EditRequiredRef<string>
   * for Title, EditOptionalVal<int> for Rating, EditList<string> for Genres/Labels).
   *
   * NOTE: boolean flags (IsPick/IsUserHidden/IsCompilation/…) are intentionally not
   * supported — the core does not respond to EditOptionalVal<bool> edits (the apply
   * hangs server-side; the encoding is correct). Genres/labels must be values Roon
   * recognises; unknown strings return Success but are silently dropped.
   */
  editAlbum(albumId: bigint, edits: AlbumEdits): Promise<CallResult> {
    const fields: StructField[] = [];
    if (edits.title !== undefined) {
      const w = this.structArg(EDIT_REQUIRED_REF_STR, [
        { name: `string ${EDIT_REQUIRED_REF_STR}::EditValue`, propType: PropertyType.String, value: new BinaryWriter().string(edits.title).toBuffer() },
      ]);
      fields.push({ name: `${EDIT_REQUIRED_REF_STR} ${ALBUM_EDIT}::Title`, propType: PropertyType.Object, value: w });
    }
    if (edits.rating !== undefined) {
      const w = this.structArg(EDIT_OPTIONAL_VAL_INT, [
        { name: `int? ${EDIT_OPTIONAL_VAL_INT}::EditValue`, propType: PropertyType.NullableInt, value: new BinaryWriter().boolean(true).integer(edits.rating).toBuffer() },
      ]);
      fields.push({ name: `${EDIT_OPTIONAL_VAL_INT} ${ALBUM_EDIT}::Rating`, propType: PropertyType.Object, value: w });
    }
    if (edits.addGenres || edits.removeGenres) {
      fields.push({ name: `${EDIT_LIST_STR} ${ALBUM_EDIT}::Genres`, propType: PropertyType.Object, value: this.editListStr(edits.addGenres ?? [], edits.removeGenres ?? []) });
    }
    if (edits.addLabels || edits.removeLabels) {
      fields.push({ name: `${EDIT_LIST_STR} ${ALBUM_EDIT}::Labels`, propType: PropertyType.Object, value: this.editListStr(edits.addLabels ?? [], edits.removeLabels ?? []) });
    }
    if (!fields.length) throw new Error('editAlbum: no edits supplied');
    return this.editAlbumStruct(albumId, fields);
  }

  /** Convenience: set just an album's rating (see editAlbum). */
  editAlbumRating(albumId: bigint, rating: number): Promise<CallResult> {
    return this.editAlbum(albumId, { rating });
  }

  /** AlbumLite::AlbumId (the long id Library::Edit keys on). */
  albumIdOf(album: RoonObject): bigint | undefined {
    for (const [k, v] of Object.entries(album.fields)) {
      if (k.endsWith('::AlbumId')) return typeof v === 'bigint' ? v : BigInt(String(v));
    }
    return undefined;
  }

  /** Build an EditList<string> wrapper value (AddValues/RemoveValues). */
  private editListStr(add: string[], remove: string[]): Buffer {
    const list = (xs: string[]) => {
      const w = new BinaryWriter().flexInt(xs.length);
      for (const x of xs) w.string(x);
      const b = w.toBuffer();
      return new BinaryWriter().integer(b.length).bytes(b).toBuffer();
    };
    return this.structArg(EDIT_LIST_STR, [
      { name: `System.Collections.Generic.IList<string> ${EDIT_LIST_STR}::AddValues`, propType: PropertyType.LengthPrefixed, value: list(add) },
      { name: `System.Collections.Generic.IList<string> ${EDIT_LIST_STR}::RemoveValues`, propType: PropertyType.LengthPrefixed, value: list(remove) },
    ]);
  }

  /** Build + send a single-album Library::Edit from pre-serialized AlbumEdit member fields. */
  private editAlbumStruct(albumId: bigint, fields: StructField[]): Promise<CallResult> {
    const albumEdit = this.structArg(ALBUM_EDIT, [
      { name: `long ${ALBUM_EDIT}::AlbumId`, propType: PropertyType.Long, value: new BinaryWriter().long(albumId).toBuffer() },
      ...fields,
    ]);
    // Albums: IList<AlbumEdit> as LengthPrefixed = int(len) + flexInt(count) + items.
    const blob = new BinaryWriter().flexInt(1).bytes(albumEdit).toBuffer();
    const libraryEdit = this.structArg(LIBRARY_EDIT, [
      {
        name: `System.Collections.Generic.IList<${ALBUM_EDIT}> ${LIBRARY_EDIT}::Albums`,
        propType: PropertyType.LengthPrefixed,
        value: new BinaryWriter().integer(blob.length).bytes(blob).toBuffer(),
      },
    ]);
    return this.call(
      'Library', 'Edit',
      [{ type: 'LibraryEdit', name: 'edit' }, { type: 'ResultCallback', name: 'cb' }],
      libraryEdit, this.serviceOid('Library'),
    );
  }
}

/** Reversible album metadata edits (see RoonClient.editAlbum). */
export interface AlbumEdits {
  title?: string;
  rating?: number;
  addGenres?: string[];
  removeGenres?: string[];
  addLabels?: string[];
  removeLabels?: string[];
}

// Library::Edit by-value struct type names (members are addressed by full name,
// which the server matches against its PropertyDescriptor.Name).
const ALBUM_EDIT = 'Sooloos.Broker.Api.AlbumEdit';
const EDIT_OPTIONAL_VAL_INT = 'Sooloos.Broker.Api.EditOptionalVal<int>';
const EDIT_REQUIRED_REF_STR = 'Sooloos.Broker.Api.EditRequiredRef<string>';
const EDIT_LIST_STR = 'Sooloos.Broker.Api.EditList<string>';
const LIBRARY_EDIT = 'Sooloos.Broker.Api.LibraryEdit';

// --- AlbumEditInfo decoding (by-value return) ---

/** One editable field: the effective value + whether the user edited it. */
export interface EditField<T> {
  value: T | undefined;
  /** the metadata (publisher) value, before any local/user edit. */
  metadataValue?: T;
  /** true when the user has a local edit overriding metadata. */
  edited: boolean;
}

export interface AlbumEditInfo {
  title: EditField<string>;
  version: EditField<string>;
  performedBy: EditField<string>;
  genres: EditField<string[]>;
  labels: EditField<string[]>;
  rating: EditField<number>;
  type: EditField<number>;
  isCompilation: EditField<boolean>;
  isLive: EditField<boolean>;
  isPick: EditField<boolean>;
  containsExplicitContent: EditField<boolean>;
  isUserHidden: EditField<boolean>;
  country: EditField<string>;
  catalogNumber: EditField<string>;
  productCode: EditField<string>;
  /** the full decoded struct, for fields not surfaced above. */
  raw: Record<string, unknown>;
}

/** Read a member of a decoded struct by its `::suffix` (keys are fully-qualified). */
function member(obj: Record<string, unknown> | undefined, suffix: string): unknown {
  if (!obj) return undefined;
  for (const [k, v] of Object.entries(obj)) if (k.endsWith(suffix)) return v;
  return undefined;
}

/** A LengthPrefixed IList<string> decodes to a Buffer of flexInt(count)+string*. */
function decodeStringList(v: unknown): string[] | undefined {
  if (!Buffer.isBuffer(v)) return Array.isArray(v) ? (v as string[]) : undefined;
  const r = new BinaryReader(Uint8Array.from(v));
  const out: string[] = [];
  const count = r.flexInt();
  for (let i = 0; i < count && r.remaining > 0; i++) out.push(r.string() ?? '');
  return out;
}

/** Extract one Edit*Info<T> wrapper field from the AlbumEditInfo struct. */
function editField<T>(info: Record<string, unknown>, fieldSuffix: string, list = false): EditField<T> {
  const wrapper = member(info, `::${fieldSuffix}`) as Record<string, unknown> | undefined;
  const rawValue = member(wrapper, list ? '::Values' : '::Value');
  const rawMeta = member(wrapper, list ? '::MetadataValues' : '::MetadataValue');
  const value = (list ? decodeStringList(rawValue) : rawValue) as T | undefined;
  const metadataValue = (list ? decodeStringList(rawMeta) : rawMeta) as T | undefined;
  return { value, metadataValue, edited: member(wrapper, '::HasEditLayer') === true };
}

function parseAlbumEditInfo(decoded: Record<string, unknown>): AlbumEditInfo {
  return {
    title: editField<string>(decoded, 'Title'),
    version: editField<string>(decoded, 'Version'),
    performedBy: editField<string>(decoded, 'PerformedBy'),
    genres: editField<string[]>(decoded, 'Genres', true),
    labels: editField<string[]>(decoded, 'Labels', true),
    rating: editField<number>(decoded, 'Rating'),
    type: editField<number>(decoded, 'Type'),
    isCompilation: editField<boolean>(decoded, 'IsCompilation'),
    isLive: editField<boolean>(decoded, 'IsLive'),
    isPick: editField<boolean>(decoded, 'IsPick'),
    containsExplicitContent: editField<boolean>(decoded, 'ContainsExplicitContent'),
    isUserHidden: editField<boolean>(decoded, 'IsUserHidden'),
    country: editField<string>(decoded, 'Country'),
    catalogNumber: editField<string>(decoded, 'CatalogNumber'),
    productCode: editField<string>(decoded, 'ProductCode'),
    raw: decoded,
  };
}
