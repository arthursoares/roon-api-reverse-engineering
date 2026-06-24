/**
 * Try to trigger schema delivery by using different ProtocolHash values
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

// Original captured hash
const ORIGINAL_HASH = 'aaedd22e2e6e452231e74dd309ffb9d27a9751ed';

// Original template (without broker ID filled in)
const ORIGINAL_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000LLHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH20810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildConnectRequest(clientBrokerId: Buffer, hash: string): Buffer {
  // Hash must be 40 hex chars = 20 bytes
  if (hash.length !== 40) {
    throw new Error(`Hash must be 40 chars, got ${hash.length}`);
  }

  let hex = ORIGINAL_TEMPLATE;
  hex = hex.replace('YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY', clientBrokerId.toString('hex'));

  // The length prefix for hash is at position LL (should be 0x28 = 40 for 40 chars, or maybe it's byte count?)
  // In original: 00000028 = 40 bytes in big endian? No, that's 0x28 = 40 (the string length)
  // Let's try keeping the same length (40 chars)
  hex = hex.replace('LLHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH', '28' + Buffer.from(hash).toString('hex'));

  return Buffer.from(hex, 'hex');
}

function buildClientHello(clientBrokerId: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

async function testHash(hash: string, description: string): Promise<number> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let totalBytes = 0;
    let responseData = Buffer.alloc(0);
    let collectTimer: NodeJS.Timeout | null = null;

    socket.setTimeout(10000);

    socket.on('connect', () => {
      step = 1;
      socket.write(buildClientHello(clientBrokerId));
    });

    socket.on('data', (data) => {
      totalBytes += data.length;
      responseData = Buffer.concat([responseData, data]);

      if (collectTimer) clearTimeout(collectTimer);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          try {
            const req = buildConnectRequest(clientBrokerId, hash);
            socket.write(req);
          } catch (e) {
            console.log(`  Error: ${e}`);
            socket.end();
          }
        }
      }
      else if (step === 3) {
        step = 4;
        // Collect data for a bit before concluding
        collectTimer = setTimeout(() => {
          socket.end();
        }, 3000);
      }
      else if (step === 4) {
        // Keep collecting
      }
    });

    socket.on('timeout', () => socket.end());
    socket.on('close', () => {
      console.log(`${description}: ${totalBytes} bytes`);

      // Show some info about the response
      if (totalBytes > 28) {
        const payload = responseData.subarray(28); // Skip handshake
        const hasSchema = payload.length > 1000;
        const hasError = payload.toString('utf8').toLowerCase().includes('error');
        console.log(`  Payload: ${payload.length} bytes, hasSchema: ${hasSchema}, hasError: ${hasError}`);

        // Look for type names
        const str = payload.toString('utf8');
        const types = str.match(/Sooloos\.[A-Za-z.]+/g) || [];
        if (types.length > 0) {
          console.log(`  Types found: ${types.slice(0, 5).join(', ')}${types.length > 5 ? '...' : ''}`);
        }
      }
      console.log('');
      resolve(totalBytes);
    });

    socket.on('error', (err) => {
      console.log(`${description}: ERROR - ${err.message}\n`);
      resolve(0);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('Testing different ProtocolHash values to trigger schema delivery');
  console.log('================================================================\n');

  // Original hash
  await testHash(ORIGINAL_HASH, 'Original hash');

  await new Promise(r => setTimeout(r, 500));

  // Slightly modified hash (change last char)
  await testHash(ORIGINAL_HASH.slice(0, -1) + 'f', 'Modified last char');

  await new Promise(r => setTimeout(r, 500));

  // All 'a's (valid hex)
  await testHash('a'.repeat(40), 'All a\'s');

  await new Promise(r => setTimeout(r, 500));

  // All '0's
  await testHash('0'.repeat(40), 'All 0\'s');

  await new Promise(r => setTimeout(r, 500));

  // Random hash
  await testHash(crypto.randomBytes(20).toString('hex'), 'Random hash');

  console.log('Done.');
}

main().catch(console.error);
