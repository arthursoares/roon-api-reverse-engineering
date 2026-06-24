/**
 * Test favorite with proper method registration
 *
 * Based on capture analysis:
 * 1. Send 0x42 schema trigger with profile GUID
 * 2. Send 0x06 method registration for FavoriteOrBan
 * 3. Send 0x43 favorite command
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// From capture: 0x42 schema trigger
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// From capture: FavoriteOrBan method registration (frame 1810)
const FAVORITE_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a466176' +
  '6f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65' +
  '722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661' +
  '766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Item ID (track to favorite)
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// From capture: the parameter bytes used (86 8e f2 47)
const PARAM_MARKER = Buffer.from('868ef247', 'hex');

function buildFavoriteCommand(msgId: number, favorite: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([0x43, msgId & 0xff]),
    Buffer.from([0x1b, 0x2d]),  // Method index from capture
    Buffer.from([0x84, 0x54]),  // Type marker (Track)
    ITEM_ID,
    PARAM_MARKER,
    Buffer.from([favorite ? 0x01 : 0x00])
  ]);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;

    socket.setTimeout(20000);

    socket.on('connect', () => {
      console.log('Connected');
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

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Session established');
          socket.write(Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          ));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('ConnectRequest accepted');
        console.log('Sending schema trigger...');
        socket.write(SCHEMA_TRIGGER);

        // Wait for some schema data, then register method and call it
        setTimeout(() => {
          console.log(`Received ${totalReceived} bytes of schema`);
          console.log('Registering FavoriteOrBan method...');
          socket.write(FAVORITE_REGISTRATION);

          setTimeout(() => {
            step = 5;
            const cmd = buildFavoriteCommand(0x06, true);
            console.log(`Sending favorite command: ${cmd.toString('hex')}`);
            socket.write(cmd);
          }, 500);
        }, 3000);
      }
      else if (step === 5) {
        // Look for response to our command (message ID 0x06)
        // Response should start with c0 06 or 80 06
        for (let i = 0; i < data.length - 2; i++) {
          if ((data[i] === 0xc0 || data[i] === 0x80) && data[i+1] === 0x06) {
            console.log(`\nFound response at offset ${i}:`);
            const resp = data.subarray(i, Math.min(i + 30, data.length));
            console.log(`  Hex: ${resp.toString('hex')}`);
            const text = resp.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
            console.log(`  Text: ${text}`);

            if (data[i] === 0xc0 && data.length - i <= 6) {
              console.log('  Type: Simple ACK - command accepted!');
            }
          }
        }

        // Also check for MissingMethod anywhere
        const text = data.toString('utf8');
        if (text.includes('MissingMethod')) {
          console.log('  ERROR: MissingMethod found in response');
          socket.end();
        } else {
          // Wait for more data or timeout
          setTimeout(() => socket.end(), 2000);
        }
      }
    });

    socket.on('timeout', () => {
      console.log(`Timeout at step ${step}`);
      socket.end();
    });

    socket.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      resolve();
    });

    socket.connect(PORT, HOST);
  });
}

console.log('Testing favorite with method registration...\n');
test().catch(console.error);
