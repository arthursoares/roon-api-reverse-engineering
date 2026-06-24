#!/usr/bin/env python3
"""
Walk the Roon binary message stream (client->server or server->client),
splitting it into individual messages and summarizing each one.

Framing (post-ROON-handshake), inferred:
  [type:1][msgId:1] then a body. For named/typed messages the body begins
  with framing bytes followed by length-prefixed type names. Rather than
  assume a perfect frame length, we scan for message-type bytes at plausible
  boundaries and extract readable strings + GUIDs in each chunk.

Usage: parse_stream.py <hexfile> [--label NAME]
"""
import sys, re

MSG_TYPES = {
    0x03: "DATA", 0x05: "STREAM", 0x06: "REGISTER", 0x07: "SCHEMA",
    0x41: "KEEPALIVE", 0x42: "SCHEMA_TRIGGER", 0x43: "CALL_INDEXED",
    0x47: "CALL_NAMED", 0x80: "RESPONSE", 0xc0: "CALLBACK",
}

def read_handshake(data, off):
    """Consume ROON-prefixed handshake frames. Returns new offset + list of frames."""
    frames = []
    while data[off:off+4] == b'ROON':
        ind = data[off+4:off+6]
        # 0104 hello = ROON+0104+16+16 ; 0102 = ROON+0102 ; 0180/0182 etc
        if ind == b'\x01\x04':
            frames.append(("ROON 0104 hello", data[off:off+38].hex()))
            off += 38
        elif ind == b'\x01\x02':
            frames.append(("ROON 0102 protoreq", data[off:off+6].hex()))
            off += 6
        elif ind == b'\x01\x80':
            frames.append(("ROON 0180 ack", data[off:off+6].hex()))
            off += 6
        elif ind == b'\x01\x82':
            frames.append(("ROON 0182 session", data[off:off+22].hex()))
            off += 22
        else:
            frames.append(("ROON ??? "+ind.hex(), data[off:off+6].hex()))
            off += 6
    return off, frames

def find_strings(chunk, minlen=4):
    """Find length-prefixed ASCII strings (1-byte len prefix)."""
    out = []
    i = 0
    while i < len(chunk)-1:
        ln = chunk[i]
        if minlen <= ln < 120 and i+1+ln <= len(chunk):
            s = chunk[i+1:i+1+ln]
            try:
                txt = s.decode('ascii')
                if all(32 <= c < 127 for c in s) and re.search(r'[A-Za-z]', txt):
                    out.append(txt)
                    i += 1+ln
                    continue
            except Exception:
                pass
        i += 1
    return out

def main():
    path = sys.argv[1]
    label = "STREAM"
    if "--label" in sys.argv:
        label = sys.argv[sys.argv.index("--label")+1]
    data = bytes.fromhex(open(path).read().strip())
    print(f"=== {label}: {len(data)} bytes ===\n")

    off, frames = read_handshake(data, 0)
    for name, hx in frames:
        print(f"[handshake] {name}: {hx}")
    print(f"\n--- post-handshake message scan (from offset {off}) ---\n")

    # Walk: at each position, if byte is a known msg type, capture up to the
    # next known msg-type byte that looks like a real boundary. This is heuristic
    # but good enough to enumerate message types + their type-name payloads.
    msgs = []
    i = off
    n = len(data)
    while i < n:
        t = data[i]
        if t in MSG_TYPES:
            # find next plausible boundary: next byte in MSG_TYPES preceded by
            # nothing obviously mid-string. Scan forward.
            j = i+2
            while j < n:
                if data[j] in MSG_TYPES and data[j] in (0x06,0x42,0x43,0x47,0x41,0x05,0x03,0x07,0x80,0xc0):
                    # crude: require the byte after type to be a small id (<0x80)
                    if j+1 < n and data[j+1] < 0x80:
                        break
                j += 1
            chunk = data[i:j]
            msgs.append((i, t, chunk))
            i = j
        else:
            i += 1

    # Summarize
    from collections import Counter
    counts = Counter(MSG_TYPES.get(t,"?%02x"%t) for _,t,_ in msgs)
    print("Message type counts:", dict(counts), "\n")

    for idx,(pos,t,chunk) in enumerate(msgs):
        strs = find_strings(chunk)
        # only print messages that carry type/method names or are calls
        interesting = strs or t in (0x43,0x42,0x06,0x47)
        if interesting:
            tname = MSG_TYPES.get(t,"?%02x"%t)
            head = chunk[:24].hex()
            print(f"#{idx} @{pos} {tname} len={len(chunk)} head={head}")
            for s in strs[:8]:
                print(f"      str: {s}")

if __name__ == "__main__":
    main()
