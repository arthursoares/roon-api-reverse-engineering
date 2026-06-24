/**
 * Test different 0x42 message formats
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// Different 0x42 variants to try
const variants = [
  { name: 'Profile GUID from capture', hex: '420210bcd36e8478a3e111b2725b4a6188709b' },
  { name: 'Short format', hex: '420201032b040100' },
  { name: 'Try with session ID placeholder', custom: true },
];

function buildFavoritePacket(msgId: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x43, msgId & 0xff, 0x1b, 0x2d, 0x84, 0x54]),
    ITEM_ID,
    Buffer.from([0x86, 0x87, 0x93, 0x0f, 0x01])
  ]);
}

async function testVariant(_name: string, triggerMsg: Buffer): Promise<string> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;

    socket.setTimeout(12000);

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
      totalReceived += data.length;

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
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
        socket.write(triggerMsg);

        // Wait for schema then send favorite
        setTimeout(() => {
          if (totalReceived < 2000) {
            resolve('No schema received');
            socket.end();
            return;
          }

          step = 5;
          socket.write(buildFavoritePacket(0x30));
        }, 3000);
      }
      else if (step === 5 && data[0] === 0xc0) {
        // Response to favorite command
        const text = data.toString('utf8');
        if (text.includes('MissingMethod')) {
          resolve('MissingMethod error');
        } else if (text.includes('Success')) {
          resolve('SUCCESS!');
        } else {
          resolve(`Response: ${data.subarray(0, 30).toString('hex')}`);
        }
        socket.end();
      }
    });

    socket.on('timeout', () => {
      resolve(`Timeout (${totalReceived} bytes received)`);
      socket.end();
    });

    socket.on('close', () => {
      if (step < 5) resolve('Connection closed early');
    });

    socket.on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('Testing different 0x42 message variants:\n');

  for (const v of variants) {
    let trigger: Buffer;
    if (v.custom) {
      // Use a random GUID
      const randomGuid = crypto.randomBytes(16);
      trigger = Buffer.concat([Buffer.from([0x42, 0x02, 0x10]), randomGuid]);
      console.log(`${v.name}:`);
      console.log(`  GUID: ${randomGuid.toString('hex')}`);
    } else if (v.hex) {
      trigger = Buffer.from(v.hex, 'hex');
      console.log(`${v.name}:`);
      console.log(`  Trigger: ${v.hex}`);
    } else {
      continue;
    }

    const result = await testVariant(v.name, trigger);
    console.log(`  Result: ${result}\n`);

    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(console.error);
