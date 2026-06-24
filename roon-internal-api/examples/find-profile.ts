/**
 * Find profile information in the protocol data
 *
 * The schema trigger uses a profile GUID. We need to find
 * what profile GUIDs are available or expected.
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// Try without schema trigger first to see what initial data we get
async function findProfiles(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client ID: ${clientBrokerId.toString('hex')}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let allData = Buffer.alloc(0);

    socket.setTimeout(10000);

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
      allData = Buffer.concat([allData, data]);

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
        console.log('Connected. Waiting for initial data (no schema trigger)...');
      }
    });

    socket.on('timeout', () => {
      console.log(`\nReceived ${allData.length} bytes without schema trigger`);

      // Look for Profile mentions
      const text = allData.toString('utf8');
      const profileMatches = text.match(/Profile[A-Za-z]*/g);
      if (profileMatches) {
        console.log(`\nProfile-related strings: ${[...new Set(profileMatches)].join(', ')}`);
      }

      // Look for potential GUIDs (16-byte hex patterns)
      // Search for common GUID patterns in the data
      console.log('\nSearching for potential profile GUIDs...');

      // Look for 16-byte sequences that might be GUIDs
      for (let i = 0; i < allData.length - 20; i++) {
        // Look for 0x10 marker (often precedes sooid/GUID)
        if (allData[i] === 0x10 && i < allData.length - 17) {
          const guid = allData.subarray(i + 1, i + 17);
          // Check if it looks like a GUID (some variation in bytes)
          const uniqueBytes = new Set(guid).size;
          if (uniqueBytes > 5) {  // Not all zeros or repetitive
            const context = allData.subarray(Math.max(0, i - 10), i).toString('utf8').replace(/[^\x20-\x7E]/g, '.');
            console.log(`  At ${i}, prefix "${context}": ${guid.toString('hex')}`);
          }
        }
      }

      // Also look for the known profile GUID
      const knownGuid = 'bcd36e8478a3e111b2725b4a6188709b';
      const hex = allData.toString('hex');
      if (hex.includes(knownGuid)) {
        const idx = hex.indexOf(knownGuid);
        console.log(`\nFound known profile GUID at position ${idx/2}`);
        console.log(`  Context: ${hex.substring(Math.max(0, idx - 40), idx + knownGuid.length + 20)}`);
      }

      // Save the data for analysis
      fs.writeFileSync('/tmp/roon-initial.bin', allData);
      console.log('\nSaved initial data to /tmp/roon-initial.bin');

      socket.end();
    });

    socket.on('close', () => resolve());
    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

findProfiles().catch(console.error);
