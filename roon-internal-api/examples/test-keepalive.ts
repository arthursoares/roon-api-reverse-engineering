/**
 * Test keepalive and basic connectivity after handshake
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const CLIENT_BROKER_ID = crypto.randomBytes(16);
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildClientHello(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

function buildConnectRequest(): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex'));
  return Buffer.from(hex, 'hex');
}

async function test(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}\n`);
      step = 1;
      socket.write(buildClientHello());
    });

    socket.on('data', (data) => {
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('1. Hello acknowledged');
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('2. Session established');
          socket.write(buildConnectRequest());
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('3. ConnectRequest accepted');
        console.log(`   Response: ${data.length} bytes\n`);

        // Wait a moment, then try different message types
        setTimeout(() => {
          console.log('=== Testing message types ===\n');

          // Try a keepalive (41 XX 00)
          console.log('Sending keepalive (41 01 00)...');
          socket.write(Buffer.from([0x41, 0x01, 0x00]));
        }, 500);
      }
      else if (step === 4) {
        console.log(`Response to keepalive: ${data.length} bytes`);
        console.log(`  Hex: ${data.toString('hex')}`);

        // If we got a response, try a few more things
        if (data[0] === 0xc0) {
          console.log('  Type: 0xc0 (server response)\n');

          // Try another keepalive with different ID
          setTimeout(() => {
            console.log('Sending another keepalive (41 02 00)...');
            socket.write(Buffer.from([0x41, 0x02, 0x00]));
            step = 5;
          }, 500);
        }
      }
      else if (step === 5) {
        console.log(`Response: ${data.length} bytes`);
        console.log(`  Hex: ${data.toString('hex')}`);

        // Try message type 0x43 (the favorite type) with just empty payload
        setTimeout(() => {
          console.log('\nTrying message type 0x43 with minimal payload (43 03 00)...');
          socket.write(Buffer.from([0x43, 0x03, 0x00]));
          step = 6;
        }, 500);
      }
      else if (step === 6) {
        console.log(`Response: ${data.length} bytes`);
        console.log(`  Hex: ${data.toString('hex')}`);
        console.log(`  Text: ${data.toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);

        setTimeout(() => socket.end(), 500);
      }
    });

    socket.on('timeout', () => {
      console.log('\nTimeout');
      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', reject);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
