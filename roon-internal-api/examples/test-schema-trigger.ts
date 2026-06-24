/**
 * Test the 0x42 message that triggers schema delivery
 *
 * Based on capture analysis, after ConnectResponse the real client sends:
 * 42 02 10 bc d3 6e 84 78 a3 e1 11 b2 72 5b 4a 61 88 70 9b
 *
 * This triggers the server to send the full schema data (~300KB)
 *
 * Run with: npx ts-node examples/test-schema-trigger.ts
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// The exact 0x42 message from the capture - this triggers schema
// We'll experiment to understand what the payload means
const SCHEMA_TRIGGER_FROM_CAPTURE = Buffer.from('4202 10 bcd36e8478a3e111b2725b4a6188709b'.replace(/\s/g, ''), 'hex');

function buildClientHello(clientBrokerId: Buffer): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from([0x01, 0x04]),
    SERVER_BROKER_ID,
    clientBrokerId
  ]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from([0x01, 0x02])
  ]);
}

function buildConnectRequest(clientBrokerId: Buffer): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace(
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    clientBrokerId.toString('hex')
  );
  return Buffer.from(hex, 'hex');
}

// Build 0x42 message - trying to understand the payload structure
function buildSchemaTrigger(msgId: number, payload?: Buffer): Buffer {
  if (payload) {
    return Buffer.concat([
      Buffer.from([0x42, msgId & 0xff]),
      payload
    ]);
  }
  // Default: use the payload from capture
  return Buffer.concat([
    Buffer.from([0x42, msgId & 0xff]),
    Buffer.from('10 bcd36e8478a3e111b2725b4a6188709b'.replace(/\s/g, ''), 'hex')
  ]);
}

async function testConnection(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let buffer = Buffer.alloc(0);
    let totalReceived = 0;
    let sessionId: Buffer | null = null;
    let schemaData: Buffer[] = [];

    socket.setTimeout(10000);  // Shorter timeout to capture schema data

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log(`Client Broker ID: ${clientBrokerId.toString('hex')}`);
      console.log('');

      step = 1;
      const hello = buildClientHello(clientBrokerId);
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
          sessionId = buffer.subarray(6, 22);
          console.log(`  Session ID: ${sessionId.toString('hex')}`);
          console.log('');

          step = 3;
          buffer = Buffer.alloc(0);

          const connectReq = buildConnectRequest(clientBrokerId);
          console.log(`Step 3 - Sending ConnectRequest (${connectReq.length} bytes)`);
          socket.write(connectReq);
        }
      }
      else if (step === 3 && buffer[0] === 0x80) {
        console.log('  ConnectRequest accepted');
        console.log(`  Response size: ${buffer.length} bytes`);

        // Extract any strings from the response
        const strings = buffer.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g);
        if (strings) {
          console.log(`  Contains ${strings.length} Sooloos type references`);
        }

        step = 4;
        schemaData.push(Buffer.from(buffer));
        buffer = Buffer.alloc(0);

        console.log('');
        console.log('Step 4 - Sending Schema Trigger (0x42 message)');

        // Try with the exact bytes from capture first
        console.log(`  Using captured payload: ${SCHEMA_TRIGGER_FROM_CAPTURE.toString('hex')}`);
        socket.write(SCHEMA_TRIGGER_FROM_CAPTURE);

        // Also try with a generated version using our session ID
        setTimeout(() => {
          if (sessionId && totalReceived < 2000) {
            console.log('');
            console.log('  Trying with session ID as payload...');
            const altTrigger = buildSchemaTrigger(0x03, Buffer.concat([
              Buffer.from([0x10]),  // prefix byte
              sessionId
            ]));
            console.log(`  Alternative: ${altTrigger.toString('hex')}`);
            socket.write(altTrigger);
          }
        }, 2000);
      }
      else if (step === 4) {
        // Receiving schema or response data
        schemaData.push(Buffer.from(data));
        process.stdout.write(`\r  Receiving data: ${totalReceived} bytes...`);
      }
    });

    socket.on('timeout', () => {
      console.log('\n');
      console.log(`Timeout after receiving ${totalReceived} bytes`);

      // Analyze what we received
      const allData = Buffer.concat(schemaData);
      console.log(`Total schema data: ${allData.length} bytes`);

      // Extract Sooloos type names
      const typeNames = allData.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g);
      if (typeNames) {
        const unique = [...new Set(typeNames)];
        console.log(`Found ${unique.length} unique Sooloos types:`);
        unique.slice(0, 20).forEach(t => console.log(`  - ${t}`));
        if (unique.length > 20) {
          console.log(`  ... and ${unique.length - 20} more`);
        }
      }

      // Save raw data for analysis
      if (allData.length > 0) {
        const outPath = '/tmp/roon-schema-data.bin';
        fs.writeFileSync(outPath, allData);
        console.log(`\nSaved raw data to ${outPath}`);

        // Also save strings
        const strPath = '/tmp/roon-schema-strings.txt';
        const strings = allData.toString('utf8')
          .split(/[\x00-\x1f]/)
          .filter(s => s.length > 5)
          .join('\n');
        fs.writeFileSync(strPath, strings);
        console.log(`Saved strings to ${strPath}`);
      }

      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      resolve();
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('Roon Internal API - Schema Trigger Test (0x42 message)');
  console.log('='.repeat(60));
  console.log('');

  await testConnection();
}

main().catch(console.error);
