/**
 * Try a simple read operation to understand the protocol better
 *
 * Let's try getting AlbumCount or TrackCount, which should be simple
 * property reads that don't require method registration.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Let's analyze the data we receive and look for patterns
async function analyzeProtocol(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client ID: ${clientBrokerId.toString('hex')}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let allData = Buffer.alloc(0);
    let messageTypes = new Map<number, number>();

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
        console.log('Connected. Analyzing ConnectResponse...');
        console.log(`  First 100 bytes: ${data.subarray(0, 100).toString('hex')}`);

        // Look at ConnectResponse structure
        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
        console.log(`  Text: ${text.substring(0, 150)}`);

        step = 4;
        console.log('\nTriggering schema...');
        socket.write(SCHEMA_TRIGGER);
      }
      else if (step === 4) {
        // Count message types
        const msgType = data[0];
        messageTypes.set(msgType, (messageTypes.get(msgType) || 0) + 1);
      }
    });

    socket.on('timeout', () => {
      console.log('\nTimeout. Analysis results:');
      console.log(`Total data received: ${allData.length} bytes`);
      console.log('\nMessage types received:');
      const sorted = [...messageTypes.entries()].sort((a, b) => b[1] - a[1]);
      sorted.forEach(([type, count]) => {
        console.log(`  0x${type.toString(16).padStart(2, '0')}: ${count} messages`);
      });

      // Look for any 0x86 or 0xc0 responses (potential method responses)
      console.log('\nSearching for response patterns:');
      for (let i = 0; i < allData.length - 2; i++) {
        const byte = allData[i];
        if (byte === 0x86 || byte === 0xc0 || byte === 0xc6) {
          const context = allData.subarray(i, Math.min(i + 20, allData.length));
          console.log(`  Found 0x${byte.toString(16)} at ${i}: ${context.toString('hex')}`);
          if (byte === 0xc0 || byte === 0xc6) break;  // Limit output
        }
      }

      // Look for Library in the data
      const text = allData.toString('utf8');
      const albumCountIdx = text.indexOf('AlbumCount');
      if (albumCountIdx > 0) {
        console.log(`\nFound AlbumCount at offset ${albumCountIdx}`);
        // Look at bytes before it
        const startIdx = Math.max(0, albumCountIdx - 50);
        console.log(`  Context (hex): ${allData.subarray(startIdx, albumCountIdx + 20).toString('hex')}`);
      }

      socket.end();
    });

    socket.on('close', () => {
      console.log('\nDone');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

analyzeProtocol().catch(console.error);
