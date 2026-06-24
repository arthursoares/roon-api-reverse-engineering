/**
 * Test favorite command after receiving schema data
 *
 * Steps:
 * 1. Complete handshake
 * 2. Send 0x42 schema trigger
 * 3. Wait for schema data
 * 4. Send favorite command
 *
 * Run with: npx ts-node examples/test-favorite-with-schema.ts
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// 0x42 message to trigger schema
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Item ID from capture (track to favorite)
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

function buildFavoritePacket(msgId: number, favorite: boolean): Buffer {
  // Using the corrected format from capture analysis:
  // 43 [msgId] 1b 2d 84 54 [19-byte itemId] 86 87 93 0f [00/01]
  return Buffer.concat([
    Buffer.from([0x43]),           // Message type
    Buffer.from([msgId & 0xff]),   // Message ID
    Buffer.from([0x1b]),           // Opcode (27)
    Buffer.from([0x2d]),           // Sub-opcode (45)
    Buffer.from([0x84, 0x54]),     // Type marker
    ITEM_ID,                       // 19-byte item ID
    Buffer.from([0x86, 0x87, 0x93, 0x0f]), // Parameter marker
    Buffer.from([favorite ? 0x01 : 0x00])  // 01=favorite, 00=unfavorite
  ]);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;
    let schemaStarted = false;
    let lastDataTime = Date.now();

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log(`Client ID: ${clientBrokerId.toString('hex')}\n`);

      step = 1;
      socket.write(Buffer.concat([
        MAGIC,
        Buffer.from([0x01, 0x04]),
        SERVER_BROKER_ID,
        clientBrokerId
      ]));
    });

    socket.on('data', (data) => {
      totalReceived += data.length;
      lastDataTime = Date.now();

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('1. Hello acknowledged');
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('2. Session established');
          socket.write(Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          ));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('3. ConnectRequest accepted');
        console.log('4. Sending schema trigger (0x42)...');
        socket.write(SCHEMA_TRIGGER);
        schemaStarted = true;
      }
      else if (step === 4 && schemaStarted) {
        process.stdout.write(`\r   Schema: ${totalReceived} bytes received...`);

        // Check if data flow has stopped (schema complete)
        setTimeout(() => {
          if (Date.now() - lastDataTime > 500 && step === 4) {
            step = 5;
            console.log(`\n5. Schema received (${totalReceived} bytes)`);
            console.log('6. Sending FAVORITE command...');

            const favPacket = buildFavoritePacket(0x30, true);
            console.log(`   Packet: ${favPacket.toString('hex')}`);
            socket.write(favPacket);
          }
        }, 600);
      }
      else if (step === 5) {
        console.log('\n7. RESPONSE RECEIVED:');
        console.log(`   Length: ${data.length} bytes`);
        console.log(`   Hex: ${data.toString('hex')}`);

        // Check first byte for response type
        if (data[0] === 0xc0) {
          console.log('   Type: Simple response (0xc0)');
        } else if (data[0] === 0x80) {
          console.log('   Type: Complex response (0x80)');
          // Extract readable strings
          const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
          console.log(`   Text: ${text.substring(0, 100)}`);
        }

        // Check for success/error
        const str = data.toString('utf8');
        if (str.includes('Success')) {
          console.log('\n   *** SUCCESS! Track favorited! ***');
        } else if (str.includes('Error') || str.includes('error')) {
          console.log('\n   *** ERROR in response ***');
        }

        socket.end();
      }
    });

    socket.on('timeout', () => {
      console.log(`\nTimeout at step ${step}`);
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

console.log('='.repeat(60));
console.log('Roon Internal API - Favorite Test (with schema)');
console.log('='.repeat(60));
console.log('');

test().catch(console.error);
