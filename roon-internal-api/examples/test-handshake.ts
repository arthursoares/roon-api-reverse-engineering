/**
 * Test script to implement the Roon handshake protocol
 * Based on captured traffic analysis
 *
 * Run with: npx ts-node examples/test-handshake.ts
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

// Server Broker ID from capture (this is your Roon Core's ID)
const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');

// Generate a random client broker ID
const CLIENT_BROKER_ID = crypto.randomBytes(16);

// Item ID from your favorite capture
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

const MAGIC = Buffer.from('ROON');

// ConnectRequest template from capture
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildClientHello(): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from([0x01, 0x04]),
    SERVER_BROKER_ID,
    CLIENT_BROKER_ID
  ]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from([0x01, 0x02])
  ]);
}

function buildConnectRequest(): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace(
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    CLIENT_BROKER_ID.toString('hex')
  );
  return Buffer.from(hex, 'hex');
}

function buildFavoritePacket(favorite: boolean): Buffer {
  const payload = Buffer.concat([
    ITEM_ID,
    Buffer.from([0x83, 0xfa, 0xa4]),
    Buffer.from([favorite ? 0x11 : 0x10]),
    Buffer.from([0x01])
  ]);

  return Buffer.concat([
    Buffer.from([0x43, 0x01, 0x1b, 0x32, 0x84, 0x54]),
    payload
  ]);
}

async function testConnection(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let step = 0;
    let buffer = Buffer.alloc(0);
    let totalReceived = 0;
    let favoriteTimer: NodeJS.Timeout | null = null;

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log('');

      step = 1;
      const hello = buildClientHello();
      console.log(`Step 1 - Sending Client Hello (${hello.length} bytes)`);
      socket.write(hello);
    });

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      totalReceived += data.length;

      // Check for ROON magic (handshake responses)
      if (buffer.length >= 6 && buffer.subarray(0, 4).toString() === 'ROON') {
        const code = buffer[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          buffer = Buffer.alloc(0);
          console.log('  Server acknowledged');
          console.log('');

          const proto = buildProtocolRequest();
          console.log(`Step 2 - Sending Protocol Request (${proto.length} bytes)`);
          socket.write(proto);
        }
        else if (step === 2 && code === 0x82) {
          const sessionId = buffer.subarray(6, 22).toString('hex');
          console.log(`  Session established: ${sessionId}`);
          console.log('');

          step = 3;
          buffer = Buffer.alloc(0);

          const connectReq = buildConnectRequest();
          console.log(`Step 3 - Sending ConnectRequest (${connectReq.length} bytes)`);
          socket.write(connectReq);
        }
      }
      else if (step === 3 && buffer[0] === 0x80) {
        console.log('  ConnectRequest accepted');
        console.log('  Receiving schema data from server...');
        step = 4;

        // Set timer to send favorite after receiving enough data
        favoriteTimer = setTimeout(() => {
          console.log(`  Received ${totalReceived} bytes total`);
          console.log('');

          step = 5;
          buffer = Buffer.alloc(0);

          const fav = buildFavoritePacket(true);
          console.log(`Step 4 - Sending Favorite command (${fav.length} bytes)`);
          console.log(`  Packet: ${fav.toString('hex')}`);
          socket.write(fav);
        }, 3000);
      }
      else if (step === 4) {
        // Still receiving schema data, update progress
        process.stdout.write(`\r  Received ${totalReceived} bytes...`);
      }
      else if (step === 5) {
        // Response to favorite command
        console.log('');
        console.log('Response received:');
        console.log(`  Length: ${buffer.length} bytes`);
        console.log(`  First bytes: ${buffer.subarray(0, 30).toString('hex')}`);

        const str = buffer.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
        if (str.includes('Success')) {
          console.log('');
          console.log('  *** SUCCESS! Track favorite status changed! ***');
          console.log('  Check Roon to verify the change.');
        } else {
          console.log(`  Response text: ${str.substring(0, 100)}`);
        }

        socket.end();
      }
    });

    socket.on('timeout', () => {
      if (favoriteTimer) {
        clearTimeout(favoriteTimer);
      }
      console.log('');
      console.log(`Timeout at step ${step} (received ${totalReceived} bytes)`);
      socket.end();
    });

    socket.on('close', () => {
      console.log('');
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', (err) => {
      if (favoriteTimer) {
        clearTimeout(favoriteTimer);
      }
      console.error('Error:', err.message);
      reject(err);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('Roon Internal API - Full Handshake Test');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Server Broker ID: ${SERVER_BROKER_ID.toString('hex')}`);
  console.log(`Client Broker ID: ${CLIENT_BROKER_ID.toString('hex')}`);
  console.log(`Item ID: ${ITEM_ID.toString('hex')}`);
  console.log('');

  try {
    await testConnection();
  } catch (err) {
    console.error('Test failed:', err);
  }
}

main();
