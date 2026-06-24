#!/usr/bin/env python3
"""
Roon/Sooloos Binary Protocol Decoder

This attempts to decode the custom binary format used by the Roon client.
The format appears to be a custom .NET-style serialization.
"""

import sys
import struct
from dataclasses import dataclass
from typing import List, Optional, Any

@dataclass
class Message:
    msg_type: int
    msg_id: int
    payload: bytes
    decoded: Optional[dict] = None

def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    """Read a variable-length integer."""
    result = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        result |= (byte & 0x7F) << shift
        offset += 1
        if not (byte & 0x80):
            break
        shift += 7
    return result, offset

def read_string(data: bytes, offset: int) -> tuple[str, int]:
    """Read a length-prefixed string."""
    if offset >= len(data):
        return "", offset
    length = data[offset]
    offset += 1
    if offset + length > len(data):
        return "", offset
    try:
        s = data[offset:offset+length].decode('utf-8', errors='replace')
    except:
        s = data[offset:offset+length].hex()
    return s, offset + length

def decode_value(data: bytes, offset: int, indent: int = 0) -> tuple[Any, int]:
    """Attempt to decode a value from the binary stream."""
    if offset >= len(data):
        return None, offset

    marker = data[offset]
    prefix = "  " * indent

    # Type markers we've observed
    if marker == 0x81:  # String field
        offset += 1
        str_len = data[offset] if offset < len(data) else 0
        offset += 1
        name, offset = read_string(data, offset - 1)
        # Read value
        if offset < len(data):
            val_len = data[offset]
            offset += 1
            value, offset = read_string(data, offset - 1)
            return {name: value}, offset
    elif marker == 0x82:  # Object/struct marker
        offset += 1
        if offset < len(data):
            type_len = data[offset]
            offset += 1
            type_name, offset = read_string(data, offset - 1)
            return {"__type__": type_name}, offset
    elif marker == 0x83:  # Collection marker
        offset += 1
        return {"__collection__": True}, offset

    return data[offset:offset+1].hex(), offset + 1

def parse_message(data: bytes) -> Optional[Message]:
    """Parse a single message from the binary data."""
    if len(data) < 3:
        return None

    msg_type = data[0]
    msg_id = data[1]

    # Find strings in the payload
    strings = []
    i = 0
    while i < len(data):
        # Look for length-prefixed strings
        if i + 1 < len(data):
            length = data[i]
            if 3 < length < 100:  # Reasonable string length
                try:
                    s = data[i+1:i+1+length].decode('utf-8')
                    if s.isprintable() and len(s) > 3:
                        strings.append((i, s))
                        i += length + 1
                        continue
                except:
                    pass
        i += 1

    return Message(
        msg_type=msg_type,
        msg_id=msg_id,
        payload=data,
        decoded={"strings": strings} if strings else None
    )

def extract_type_info(data: bytes) -> List[str]:
    """Extract .NET type information from the binary data."""
    types = []
    i = 0
    while i < len(data) - 10:
        # Look for "Sooloos." pattern
        if data[i:i+8] == b'Sooloos.':
            # Find the end of the type name
            end = i + 8
            while end < len(data) and (data[end:end+1].isalnum() or data[end:end+1] in [b'.', b':', b'<', b'>', b',', b' ', b'_']):
                end += 1
            type_name = data[i:end].decode('utf-8', errors='replace')
            if type_name not in types:
                types.append(type_name)
            i = end
        # Look for "MusicQuery." pattern
        elif data[i:i+11] == b'MusicQuery.':
            end = i + 11
            while end < len(data) and (data[end:end+1].isalnum() or data[end:end+1] in [b'.', b'_']):
                end += 1
            type_name = data[i:end].decode('utf-8', errors='replace')
            if type_name not in types:
                types.append(type_name)
            i = end
        else:
            i += 1
    return types

def analyze_pcap_hex(hex_data: str):
    """Analyze hex data from tcpdump/tshark."""
    data = bytes.fromhex(hex_data.replace(' ', '').replace('\n', ''))

    print(f"=== Message Analysis ===")
    print(f"Total length: {len(data)} bytes")
    print(f"First byte (type): 0x{data[0]:02X} ('{chr(data[0]) if 32 <= data[0] < 127 else '?'}')")
    print(f"Second byte (id): 0x{data[1]:02X}")

    # Extract type information
    types = extract_type_info(data)
    if types:
        print(f"\nType information found:")
        for t in types:
            print(f"  - {t}")

    # Parse the message
    msg = parse_message(data)
    if msg and msg.decoded and msg.decoded.get("strings"):
        print(f"\nStrings found:")
        for offset, s in msg.decoded["strings"][:20]:  # First 20 strings
            print(f"  @{offset}: {s}")

def main():
    if len(sys.argv) > 1:
        # Read hex data from file or argument
        if sys.argv[1] == '-f':
            with open(sys.argv[2], 'r') as f:
                hex_data = f.read()
        else:
            hex_data = sys.argv[1]
        analyze_pcap_hex(hex_data)
    else:
        # Interactive mode - read from stdin
        print("Enter hex data (Ctrl+D to end):")
        hex_data = sys.stdin.read()
        analyze_pcap_hex(hex_data)

if __name__ == "__main__":
    main()
