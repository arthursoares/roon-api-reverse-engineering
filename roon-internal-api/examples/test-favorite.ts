/**
 * Test script to verify favorite functionality using captured packet data
 *
 * This sends the exact bytes captured from a real favorite operation.
 * Run with: npx ts-node examples/test-favorite.ts
 */

import * as net from 'net';

// Roon Core connection details
const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

// Exact packet bytes from the capture (favorite=true)
// 43 15 1b 32 84 54 12 3f 01 16 20 27 27 3a 55 d6 4b bf 4a 85 f3 35 41 0e 2f 83 fa a4 11 01
const FAVORITE_PACKET = Buffer.from(
  '43001b328454123f01162027273a55d64bbf4a85f335410e2f83faa41101',
  'hex'
);

// Exact packet bytes from the capture (favorite=false / unfavorite)
// 43 0c 1b 32 84 54 12 3f 01 16 20 27 27 3a 55 d6 4b bf 4a 85 f3 35 41 0e 2f 83 fa a4 10 01
const UNFAVORITE_PACKET = Buffer.from(
  '43001b328454123f01162027273a55d64bbf4a85f335410e2f83faa41001',
  'hex'
);

// The item ID from the capture (19 bytes - longer than expected 16-byte Sooid)
const CAPTURED_ITEM_ID = '123f01162027273a55d64bbf4a85f335410e2f';

async function testFavorite(favorite: boolean): Promise<void> {
  const packet = favorite ? FAVORITE_PACKET : UNFAVORITE_PACKET;
  const action = favorite ? 'Favorite' : 'Unfavorite';

  console.log(`Testing ${action} operation...`);
  console.log(`Packet: ${packet.toString('hex')}`);
  console.log(`Item ID: ${CAPTURED_ITEM_ID}`);
  console.log();

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let responseReceived = false;

    socket.setTimeout(5000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log('Sending packet...');
      socket.write(packet);
    });

    socket.on('data', (data) => {
      responseReceived = true;
      console.log('Response received:');
      console.log(`  Hex: ${data.toString('hex')}`);
      console.log(`  Length: ${data.length} bytes`);

      // Try to extract readable strings
      const str = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
      console.log(`  ASCII: ${str}`);

      socket.end();
    });

    socket.on('timeout', () => {
      if (!responseReceived) {
        console.log('Timeout - no response received (this might still mean success)');
      }
      socket.end();
    });

    socket.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      reject(err);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0] || 'favorite';

  console.log('='.repeat(60));
  console.log('Roon Internal API - Favorite Test');
  console.log('='.repeat(60));
  console.log();

  try {
    if (action === 'unfavorite' || action === 'false' || action === '0') {
      await testFavorite(false);
    } else {
      await testFavorite(true);
    }
    console.log();
    console.log('Test complete!');
    console.log();
    console.log('Check in Roon if the track favorite status changed.');
    console.log('To toggle: npx ts-node examples/test-favorite.ts unfavorite');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

main();
