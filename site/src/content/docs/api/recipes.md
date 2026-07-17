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
```

Get the durable `albumId` (distinct from the session oid) with `roon.albumIdOf(album)`.
`examples/edit-album.ts`, `examples/album-edit-info.ts`.

:::caution
Edits change real metadata. They're reversible (set → read back → restore), but test on
something disposable first.
:::

## Search

```ts
const albums = await roon.searchAlbums('Miles');   // in-library albums
const objects = await roon.search('Miles Davis');  // mixed: albums/tracks/performers
```

In-library / currently-loaded search half-works. **Full streaming-catalog search**
(arbitrary Tidal/Qobuz terms) is the biggest unfinished piece — see
[how this went](/journey/#where-it-stands) and [contributing](/contributing/).
`examples/search-albums.ts`, `examples/poc-search.ts`.

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
