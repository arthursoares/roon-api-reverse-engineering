#!/usr/bin/env python3
"""
Decode a Roon binary query/browse RESPONSE well enough to extract
(track/album name -> ephemeral object handle) pairs.

Why: to favorite a track via FavoriteOrBan we must pass the track's *ephemeral
session handle* (e.g. a1 8c 67), which the server only reveals inside a query
response. This proves we can recover, from a human-readable name, the exact
handle to pass to the mutation.

Observed encoding (from captures/from-start.pcap, server->client):
  - Object handle reference:  a1 <hi> <lo>   (marker 0xa1 + 2-byte id)
                              a0 <hi> <lo>   (another handle flavor)
  - Tagged field value:       <tag:1> <len:1> <bytes:len>
    Strings are UTF-8. A "name-bearing" object looks like:
        a1 HH HH  03 <len> <Title>  04 <len> <sortkey>  05 <len> <display>
  - A track/entity object links to its name-bearing object via adjacency:
        a1 TRACK  03 09  a1 NAMEOBJ ...
    and later:
        a1 NAMEOBJ  03 <len> <Title> ...

So: map NAMEOBJ -> Title, map TRACK -> NAMEOBJ, join to get TRACK -> Title.

Usage: decode_query.py <server_hex_file>
"""
import sys, re

def is_text(b):
    try:
        b.decode('utf-8')
    except Exception:
        return False
    # mostly printable, allow latin/accents via utf-8
    printable = sum(1 for c in b if c >= 32 or c in (9,))
    return printable == len(b) and len(b) >= 2

def main():
    data = bytes.fromhex(open(sys.argv[1]).read().strip())

    H = re.compile(rb'\xa1(..)', re.S)  # a1 + 2 bytes

    # 1) name-bearing objects: a1 HH HH 03 <len> <utf8 title>
    #    require it to be followed by a 04 <len> sibling (sortkey) to avoid noise.
    name_of = {}   # handle bytes(2) -> title str
    title_positions = []
    i = 0
    n = len(data)
    while i < n - 5:
        if data[i] == 0xa1:
            handle = data[i+1:i+3]
            j = i + 3
            if data[j] == 0x03:
                ln = data[j+1]
                s = data[j+2:j+2+ln]
                if 2 <= ln < 120 and is_text(s):
                    # check for a 04 <len> sibling right after (sortkey)
                    k = j + 2 + ln
                    if k+1 < n and data[k] == 0x04:
                        ln2 = data[k+1]
                        if is_text(data[k+2:k+2+ln2]):
                            title = s.decode('utf-8')
                            name_of[handle] = title
                            title_positions.append((i, handle, title))
                            i = k
                            continue
        i += 1

    # 2) track/entity objects: a1 TRACK 03 <len> a1 NAMEOBJ
    #    (the link field's length byte varies: 0x09, 0x0c, ... — accept any.)
    links = {}  # track handle(2) -> nameobj handle(2)
    i = 0
    while i < n - 8:
        if data[i] == 0xa1 and data[i+3] == 0x03 and data[i+5] == 0xa1:
            track = data[i+1:i+3]
            nameobj = data[i+6:i+8]
            links.setdefault(track, nameobj)
        i += 1

    # 3) join
    print(f"name-bearing objects found: {len(name_of)}")
    print(f"track->nameobj links found: {len(links)}\n")

    resolved = []
    for track, nameobj in links.items():
        if nameobj in name_of:
            resolved.append((track, nameobj, name_of[nameobj]))

    print(f"=== resolved track-handle -> name ({len(resolved)}) ===")
    for track, nameobj, title in resolved[:60]:
        print(f"  track a1{track.hex()}  -> name a1{nameobj.hex()}  = {title!r}")

    # Verify the favorited track
    target = bytes.fromhex('8c67')
    print(f"\n=== verification: handle a18c67 (the track favorited in capture) ===")
    if target in links:
        nm = name_of.get(links[target])
        print(f"  a18c67 links to a1{links[target].hex()} = {nm!r}")
    else:
        print("  a18c67 not found as a linking track object; searching name objects...")
    if target in name_of:
        print(f"  a18c67 is itself a name object: {name_of[target]!r}")

if __name__ == '__main__':
    main()
