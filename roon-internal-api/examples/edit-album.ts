/**
 * Edit album metadata via Library::Edit (Phase E, write side) — PROVEN LIVE.
 * Reversible demo: changes title + rating + a genre in one combined edit, confirms
 * via read-back, then restores the originals. Metadata edits are a user edit-layer
 * the core persists; re-setting the prior values restores them.
 *
 * Validated field types: title (EditRequiredRef<string>), rating
 * (EditOptionalVal<int>), genres/labels (EditList<string>, known values only).
 * Boolean flags (IsPick/IsUserHidden/…) are NOT supported — the core hangs on
 * EditOptionalVal<bool> applies (see docs/plans/2026-06-12-metadata-edit-findings.md).
 *
 *   npx ts-node examples/edit-album.ts "Album Title"
 */
import { RoonClient } from '../src/index';
import { RoonObject } from '../src/proto/objects';

const titleOf = (o: RoonObject) => { for (const [k, v] of Object.entries(o.fields)) if (k.endsWith('::Title') && typeof v === 'string') return v as string; return undefined; };

(async () => {
  const want = process.argv[2];
  const roon = new RoonClient({ host: process.env.ROON_HOST || 'YOUR_CORE_IP', serverBrokerId: Buffer.from('YOUR_SERVER_BROKER_ID', 'hex') });
  await roon.connect();
  const album = roon.graph.findByType('AlbumLite').find((a) => !want || titleOf(a) === want) ?? roon.graph.findByType('AlbumLite')[0];
  const id = roon.albumIdOf(album);
  if (!id) throw new Error('no AlbumId');
  const read = async () => roon.getAlbumEditInfo(album.oid);
  const settle = () => new Promise((r) => setTimeout(r, 700));

  const i0 = await read();
  const t0 = i0.title.value as string, r0 = i0.rating.value as number, g0 = (i0.genres.value as string[]) ?? [];
  const lastGenre = g0[g0.length - 1];
  console.log(`BEFORE   title=${JSON.stringify(t0)} rating=${r0} genres=${g0.length}`);

  console.log('combined edit:', (await roon.editAlbum(id, { title: `${t0} (test)`, rating: r0 === 7 ? 6 : 7, removeGenres: lastGenre ? [lastGenre] : [] })).status);
  await settle();
  const i1 = await read();
  console.log(`AFTER    title=${JSON.stringify(i1.title.value)} rating=${i1.rating.value} genres=${(i1.genres.value as string[]).length}`);

  console.log('restore:', (await roon.editAlbum(id, { title: t0, rating: r0, addGenres: lastGenre ? [lastGenre] : [] })).status);
  await settle();
  const i2 = await read();
  console.log(`RESTORED title=${JSON.stringify(i2.title.value)} rating=${i2.rating.value} genres=${(i2.genres.value as string[]).length}`);

  roon.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
