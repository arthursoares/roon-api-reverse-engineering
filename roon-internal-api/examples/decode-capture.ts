/**
 * Validate the generic object reader against the real captured server stream
 * (from-start.pcap, server->client). Recovers types + objects and checks we can
 * find the Library service object and the known track names — the same ground
 * truth tools/decode_query.py established, but now via the exact ported codec.
 */
import * as fs from 'fs';
import { FrameParser } from '../src/proto/frame';
import { ObjectGraph, isRef } from '../src/proto/objects';

const HEX = process.argv[2] || '/tmp/roon-analysis/start-srv.hex';
const raw = Buffer.from(fs.readFileSync(HEX, 'utf8').trim(), 'hex');
// Skip the two leading ROON handshake packets (0180 ack=6B, 0182 session=22B).
const frames = new FrameParser().push(raw.subarray(28));

const graph = new ObjectGraph();
let ingested = 0;
for (const f of frames) if (graph.ingest(f)) ingested++;

console.log(`frames parsed: ${frames.length}, object/type frames ingested: ${ingested}`);
console.log(`types defined: ${graph.types.size}, objects: ${graph.objects.size}`);

// 1) Library service object
const libs = graph.findByType('Library');
console.log(`\nLibrary objects: ${libs.map((o) => `oid=${o.oid}`).join(', ') || 'none'}`);
for (const svc of ['Transport', 'Playlists', 'Broker']) {
  const m = graph.findByType(svc);
  if (m.length) console.log(`${svc} object: oid=${m[0].oid}`);
}

// 2) Track names — find objects with a string field matching the known tracks.
const wanted = ['Desde que o samba é samba', 'Eu vim da Bahia', 'Desafinado'];
console.log('\nTrack-name lookup:');
for (const o of graph.objects.values()) {
  for (const [fname, val] of Object.entries(o.fields)) {
    if (typeof val === 'string' && wanted.includes(val)) {
      console.log(`  oid=${o.oid} type=${o.typeName.split('.').pop()} ${fname}=${JSON.stringify(val)}`);
    }
  }
}

// 3) Sanity: show one fully-decoded track-ish object's fields
const named = [...graph.objects.values()].find((o) =>
  Object.values(o.fields).includes('Desde que o samba é samba')
);
if (named) {
  console.log(`\nSample decoded object oid=${named.oid} (${named.typeName}):`);
  for (const [k, v] of Object.entries(named.fields).slice(0, 12)) {
    console.log(`  ${k} = ${isRef(v) ? `ref(${v.$ref})` : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`);
  }
}
