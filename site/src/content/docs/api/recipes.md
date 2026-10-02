---
title: Recipes
description: The bits that worked when I tried them — favorites, playback, transport, standby, a metadata edit, search, and the generated method surface.
sidebar:
  order: 2
---

These map to runnable scripts in
[`roon-internal-api/examples/`](https://github.com/arthursoares/roon-api-reverse-engineering/tree/main/roon-internal-api/examples).
All assume a connected `roon: RoonClient` (see [Getting started](/api/getting-started/)) and
your own zone/album names. Each of these worked against my Core when I tried it by hand —
that's the extent of the testing.

## Favorite an album

```ts
const album = roon.findByTitle('AlbumLite', 'Kind of Blue');
if (album) await roon.favoriteAlbum(roon.albumIdOf(album)!, true);   // false to un-favorite
```

Showed up in the Roon UI; reversible. `examples/live-favorite.ts`.

## Play

```ts
// by oids
await roon.playAlbum(zoneOid, albumOid);
await roon.playTrack(zoneOid, trackOid);

// or by name, in one call
await roon.playAlbumOnZone('Living Room', 'Kind of Blue');
```

`examples/live-play.ts`. **This produces sound** — point it at a zone you don't mind
interrupting.

## Transport & power

```ts
const zone = roon.zoneByName('Living Room')!;
roon.zoneControl(zone, 'Pause');  // 'Play' | 'PlayPause' | 'Stop' | 'Next' | 'Previous'

const ep = roon.endpointByName('Living Room')!;
roon.standby(ep);          // fire-and-forget standby
await roon.powerOn(ep);    // ConvenienceSwitch power-on
```

`examples/live-pause.ts`, `examples/live-standby.ts`.

## Metadata editing

The original reason for the whole experiment — things the public extension API can't do.
This goes through `Library::Edit`. It worked and was reversible in my testing, but it's
editing real library metadata, so be careful.

```ts
// read current editable metadata
const info = await roon.getAlbumEditInfo(albumOid);

// edit rating (1–5)
await roon.editAlbumRating(albumId, 5);

// edit several fields at once
await roon.editAlbum(albumId, {
  title: 'New Title',
  genres: ['Jazz'],
  labels: ['Columbia'],
});

// drop the title edit again (sends Title.ClearEdits)
await roon.editAlbum(albumId, { clearTitle: true });
```

In the edit info, `edited` means the user changed that field: `editValue` is set, or for
lists `AddValues`/`RemoveValues` are non-empty. `hasEditLayer` only says the album has an
edit layer, which albums nobody touched can have too.

Get the durable `albumId` (distinct from the session oid) with `roon.albumIdOf(album)`.
`examples/edit-album.ts`, `examples/album-edit-info.ts`.

:::caution
Edits change real metadata. They're reversible (set → read back → restore), but test on
something disposable first.
:::

## Search

```ts
const objects = await roon.search('Miles Davis');  // albums/tracks/performers/works
const withSections = await roon.search('Jazz', 50, true); // also playlists and genres
```

UnifiedSearch follows the Core's returned memberships, including cached results on
repeated queries. The optional third argument retains playlist and genre results;
existing callers keep the four entity families shown above. These reads were checked
against Roon 2.73 build 1696. Broader streaming-catalog behavior still needs validation.

### Album queries

`queryAlbums` runs `Library::VirtualAlbumQuery` with any `AlbumQueryCriteria` members. It
collects every match's durable `AlbumId` through the query object's `SelectAll` +
`GetSelected`, fetches the first `resolveLimit` albums (default 40) with `getAlbumById`, and
disposes the server-side query. `searchAlbums(term, limit)` is a text-filter shortcut on top
of it.

```ts
import { BinaryWriter, PropertyType } from 'roon-internal-api';

const { count, ids, albums } = await roon.queryAlbums([
  { name: 'TextFilter', propType: PropertyType.String, value: new BinaryWriter().string('Kind of Blue').toBuffer() },
], { resolveLimit: 10 });
const firstTen = await roon.searchAlbums('Kind of Blue', 10);
```

Query pages arrive through `Page` events, so reading `$items` after `RetainPage` (what
`searchAlbums` used to do) stays empty. Checked on Roon 2.73 build 1696 with a favorites
query (`RequireIsFavorite`), which returned the same 170 albums as the desktop client.
`examples/poc-search.ts` remains an experimental research path; historical findings are
preserved in [the journey](/journey/#where-it-stands).

## The full generated API

Every method in the extracted catalog is generated as a typed wrapper. `makeApi(client)`
binds the singleton services; entity classes take an explicit object id.

```ts
import { makeApi } from 'roon-internal-api';

const api = makeApi(roon /* RoonClient's underlying RemotingClient */);
await api.library.favoriteOrBan(/* … */);
```

Arguments are built from each parameter's kind (sooid / primitive / enum / ref / struct /
list / callback). The generator is `tools/gen_client.ts`; output is `src/generated/api.ts`.

:::caution[Generated ≠ tested]
This is the big asterisk on the whole project. ~1550 methods are generated and type-check,
but only the handful above have been run against a real Core. The encoding for those is
checked against captures; everything else is correct-by-construction at best and **completely
untested** at worst. Validate before relying on any of it —
[here's how](/contributing/#validating-a-method).
:::
