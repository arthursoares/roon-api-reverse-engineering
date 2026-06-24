/**
 * Debug handshake v3 - use original template, modify ProtocolHash
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const CLIENT_BROKER_ID = crypto.randomBytes(16);
const MAGIC = Buffer.from('ROON');

// Original captured ConnectRequest template
// Contains: ClientBrokerId (XXXX placeholder), ClientBrokerName=HQ-00452,
// ProtocolVersion=28, ProtocolHash=aaedd22e..., ClientBranch=production
const ORIGINAL_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// New hash (all zeros) to force schema delivery
const NEW_HASH = '0000000000000000000000000000000000000000';

function buildConnectRequestWithNewHash(): Buffer {
  let hex = ORIGINAL_TEMPLATE;
  // Replace broker ID
  hex = hex.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex'));
  // Replace the original hash with zeros
  hex = hex.replace('6161656464323265326536653435323233316537346464333039666662396432376139373531656',
                    Buffer.from(NEW_HASH).toString('hex'));
  return Buffer.from(hex, 'hex');
}

function buildConnectRequestOriginal(): Buffer {
  const hex = ORIGINAL_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex'));
  return Buffer.from(hex, 'hex');
}

function buildClientHello(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

async function testWithHash(useNewHash: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;
    let dataCollectTimer: NodeJS.Timeout | null = null;

    socket.setTimeout(15000);

    socket.on('connect', () => {
      console.log(`\n=== Testing with ${useNewHash ? 'NEW (zeros)' : 'ORIGINAL'} ProtocolHash ===`);
      step = 1;
      socket.write(buildClientHello());
    });

    socket.on('data', (data) => {
      totalReceived += data.length;
      if (dataCollectTimer) clearTimeout(dataCollectTimer);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          const req = useNewHash ? buildConnectRequestWithNewHash() : buildConnectRequestOriginal();
          console.log(`  Sending ConnectRequest (${req.length} bytes)`);
          socket.write(req);
        }
      }
      else if (step >= 3) {
        if (step === 3) {
          step = 4;
          console.log(`  First response: ${data.length} bytes`);
        }
        process.stdout.write(`\r  Total received: ${totalReceived} bytes`);

        dataCollectTimer = setTimeout(() => {
          console.log('');
          socket.end();
        }, 2000);
      }
    });

    socket.on('timeout', () => {
      console.log(`\n  Timeout at ${totalReceived} bytes`);
      socket.end();
    });

    socket.on('close', () => {
      resolve(totalReceived);
    });

    socket.on('error', reject);
    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('Comparing ProtocolHash effects on schema delivery');
  console.log('================================================');

  // Test with original hash
  const originalBytes = await testWithHash(false);
  console.log(`  Result: ${originalBytes} bytes`);

  // Wait a bit between connections
  await new Promise(r => setTimeout(r, 1000));

  // Test with new hash
  const newHashBytes = await testWithHash(true);
  console.log(`  Result: ${newHashBytes} bytes`);

  console.log('\n=== Summary ===');
  console.log(`Original hash: ${originalBytes} bytes`);
  console.log(`Zero hash:     ${newHashBytes} bytes`);
}

main().catch(console.error);
