/**
 * Find the FavoriteOrBan method index in the schema response
 *
 * The schema delivery (0x07 messages) should contain method definitions
 * and their assigned indices.
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function findMethodIndex(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client Broker ID: ${clientBrokerId.toString('hex')}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let schemaBuffer = Buffer.alloc(0);
    let schemaMessages: Buffer[] = [];

    socket.setTimeout(15000);

    socket.on('connect', () => {
      step = 1;
      socket.write(Buffer.concat([
        MAGIC,
        Buffer.from([0x01, 0x04]),
        SERVER_BROKER_ID,
        clientBrokerId
      ]));
    });

    socket.on('data', (data) => {
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          ));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('ConnectRequest accepted. Triggering schema...\n');
        socket.write(SCHEMA_TRIGGER);
      }
      else if (step === 4) {
        schemaBuffer = Buffer.concat([schemaBuffer, data]);
        schemaMessages.push(data);

        // Look for FavoriteOrBan in the data
        const text = data.toString('utf8');
        if (text.includes('FavoriteOrBan')) {
          console.log('='.repeat(60));
          console.log('FOUND FavoriteOrBan in message!');
          console.log(`Message type: 0x${data[0].toString(16)}`);
          console.log(`Message size: ${data.length} bytes`);
          console.log(`Hex (first 200): ${data.subarray(0, 200).toString('hex')}`);

          // Find the exact position
          const idx = text.indexOf('FavoriteOrBan');
          console.log(`\nContext around FavoriteOrBan:`);
          console.log(text.substring(Math.max(0, idx - 50), idx + 100).replace(/[^\x20-\x7E]/g, '.'));

          // Look for method index patterns before the method name
          const hexStr = data.toString('hex');
          const nameHex = Buffer.from('FavoriteOrBan').toString('hex');
          const hexIdx = hexStr.indexOf(nameHex);
          if (hexIdx >= 0) {
            console.log(`\nBytes before FavoriteOrBan (20 bytes): ${hexStr.substring(Math.max(0, hexIdx - 40), hexIdx)}`);
          }
          console.log('='.repeat(60));
        }

        // Also look for "Library::" pattern
        if (text.includes('Library::')) {
          const matches = text.match(/Library::\w+/g);
          if (matches) {
            console.log(`Found Library methods: ${[...new Set(matches)].join(', ')}`);
          }
        }
      }
    });

    socket.on('timeout', () => {
      console.log(`\n${'='.repeat(60)}`);
      console.log('TIMEOUT - Analyzing collected schema...');
      console.log(`Total schema data: ${schemaBuffer.length} bytes`);
      console.log(`Total messages: ${schemaMessages.length}`);

      // Save schema for offline analysis
      fs.writeFileSync('/tmp/roon-schema.bin', schemaBuffer);
      console.log('Saved schema to /tmp/roon-schema.bin');

      // Look for all method signatures
      const text = schemaBuffer.toString('utf8');
      const methodMatches = text.match(/[A-Za-z]+::[A-Za-z]+\([^)]+\)/g);
      if (methodMatches) {
        console.log(`\nFound ${methodMatches.length} method signatures:`);
        const uniqueMethods = [...new Set(methodMatches)];
        uniqueMethods.forEach((m, i) => {
          if (m.includes('Favorite') || m.includes('Library')) {
            console.log(`  [${i}] ${m}`);
          }
        });
      }

      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

findMethodIndex().catch(console.error);
