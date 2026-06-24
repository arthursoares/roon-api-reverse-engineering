# Capture & Analysis Guide

Quick reference for capturing and analyzing Roon traffic.

## Your Setup

- **Roon Core IP**: `YOUR_CORE_IP`
- **Internal API Port**: `9332`
- **Your Machine**: `YOUR_MACHINE_IP`

## Capture Commands

### Basic capture
```bash
sudo tcpdump -i any -w captures/roon-session.pcap host YOUR_CORE_IP and port 9332
```

### Live view (see traffic in real-time)
```bash
sudo tcpdump -i any -A host YOUR_CORE_IP and port 9332
```

## Analysis Commands

### Extract all strings from capture
```bash
tshark -r captures/YOUR_CAPTURE.pcap -Y "tcp.payload" -T fields -e tcp.payload 2>/dev/null | \
  xxd -r -p | strings -n 10 > /tmp/roon-strings.txt
```

### Find API methods
```bash
cat /tmp/roon-strings.txt | grep -E "::[A-Z][a-zA-Z]+\("
```

### Find Sooloos types
```bash
cat /tmp/roon-strings.txt | grep -oE "Sooloos\.[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+" | sort -u
```

### Use the decoder
```bash
tshark -r captures/YOUR_CAPTURE.pcap -Y "tcp.payload && frame.len > 100" -T fields -e tcp.payload 2>/dev/null | \
  head -1 | python3 tools/decode_roon.py
```

## Actions to Capture

Perform these in Roon while capturing to discover different API methods:

### Library/Metadata (Priority)
- [ ] Edit track metadata (right-click → Edit)
- [ ] Edit album metadata
- [ ] Add/remove from library
- [ ] Merge albums
- [ ] Identify album

### Favorites/Tags
- [ ] Favorite a track/album (heart icon)
- [ ] Unfavorite
- [ ] Add tag to item
- [ ] Remove tag
- [ ] Ban a track

### Playlists
- [ ] Create new playlist
- [ ] Add tracks to playlist
- [ ] Remove tracks from playlist
- [ ] Reorder playlist
- [ ] Delete playlist

### Playback/Queue
- [ ] Add to queue
- [ ] Play next
- [ ] Clear queue
- [ ] Reorder queue
- [ ] Start radio

### Focus/Filtering
- [ ] Use Focus feature
- [ ] Filter by genre/artist/etc

## What to Look For

In the captured strings, search for:
- Method calls: `::MethodName(`
- Types with "Edit", "Update", "Set", "Add", "Remove", "Delete", "Create"
- New `Sooloos.Broker.Api.*` types not yet documented
