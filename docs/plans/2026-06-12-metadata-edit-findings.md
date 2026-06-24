# Metadata editing — live validation findings (2026-06-12)

Phase E (the project's original north star) is **working**. `Library::Edit` writes
were validated end-to-end against the live core (user-consented, every test fully
reversible — set → read-back → restore).

## Encoding (validated)
`Library::Edit(LibraryEdit, ResultCallback)` where `LibraryEdit` is a by-value
struct:
```
LibraryEdit { Albums: IList<AlbumEdit> }          // member by FULL name
  Albums  -> LengthPrefixed(24): int(len) + flexInt(count) + <AlbumEdit inline value object>*
AlbumEdit { AlbumId: long, <field>: Edit*<T> ... } // AlbumId = AlbumLite::AlbumId (≠ oid)
  each Edit*<T> field -> Object(23): an inline value object of the wrapper type
```
Wrapper types and the member that carries the new value:
| field          | wrapper                       | member (full name) carries        | propType |
|----------------|-------------------------------|-----------------------------------|----------|
| Title          | `EditRequiredRef<string>`     | `…::EditValue` (string)           | String   |
| Rating         | `EditOptionalVal<int>`        | `…::EditValue` (int?)             | NullableInt |
| Genres/Labels  | `EditList<string>`            | `…::AddValues` / `…::RemoveValues`| LengthPrefixed |

Struct members **must** be addressed by their full property name
`"<wireType> <FullTypeName>::<Member>"` — the server matches on `PropertyDescriptor.Name`
and silently drops unmatched members (`TypeMappingHelper.DefineType`). NullableBool
is a single tri-state byte (1/0/2=null); Bool is one byte; NullableInt is
`bool(present)+int`.

## Results
| field type                     | result                                              |
|--------------------------------|-----------------------------------------------------|
| Title (`EditRequiredRef<string>`)   | ✅ set + restore confirmed                      |
| Rating (`EditOptionalVal<int>`)     | ✅ set + restore confirmed                      |
| Genres / Labels (`EditList<string>`)| ✅ remove/add of **known** values confirmed     |
| Combined (title+rating+genre, one Edit) | ✅ all changed + all restored in one call  |
| Boolean flags (`EditOptionalVal<bool>`) | ⚠️ **core does not respond** (see below)    |

## Known limitation: boolean album flags
`IsPick`, `IsUserHidden`, `IsCompilation`, `IsLive`, `ContainsExplicitContent`
(all `EditOptionalVal<bool>`) **time out** — the core sends no response. This is
NOT an encoding error: NullableBool is a single byte (confirmed against the
decompiled `RemotingUtils.WriteOptionalBoolean`/`ReadOptionalBoolean`), the
wrapper decodes (other `Edit*` members in the same AlbumEdit apply fine), and the
type is registered (unknown types would be skipped → Success, not a hang). The
apply hangs server-side for boolean flag edits specifically. `RoonClient.editAlbum`
therefore omits boolean flags by design.

## Caveat: genre/label values
Adding an **unknown** genre/label returns `Success` but is silently dropped — Roon
validates against its taxonomy. Removing/adding values already present on the album
works. (`editAlbum` passes strings through as-is.)

## API
- `RoonClient.getAlbumEditInfo(oid)` — read editable metadata (by-value decode).
- `RoonClient.editAlbum(albumId, { title?, rating?, addGenres?, removeGenres?,
  addLabels?, removeLabels? })` — reversible write. `albumIdOf(album)` → AlbumId.
- `RoonClient.editAlbumRating(albumId, rating)` — convenience.

Same machinery extends to Track/Performer/Work/Genre via TrackEdit/PerformerEdit/…
in the LibraryEdit lists (not yet wired).
