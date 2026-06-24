/**
 * Try to call favorite using named method (0x47 format)
 *
 * The 0x47 format sends the full method name as a string, which
 * should work regardless of method index assignment.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Item ID
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// Different method names to try for setting favorites
const methodsToTry = [
  'Sooloos.Broker.Api.TrackLite::SetIsFavorite',
  'Sooloos.Broker.Api.Track::SetIsFavorite',
  'Sooloos.Broker.Api.Library::SetFavorite',
  'Sooloos.Broker.Api.Library::SetTrackFavorite',
  'Sooloos.Broker.Api.ProfileData::SetFavorite',
];

function buildNamedMethodCall(msgId: number, methodName: string, payload: Buffer): Buffer {
  // 0x47 message format: 47 [msgId] 81 67 00 00 00 01 00 01 [len] [method name] [payload] 05 03 05 03
  const nameBytes = Buffer.from(methodName);

  return Buffer.concat([
    Buffer.from([0x47, msgId & 0xff]),
    Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
    Buffer.from([nameBytes.length]),
    nameBytes,
    payload,
    Buffer.from([0x05, 0x03, 0x05, 0x03])
  ]);
}

async function testMethod(methodName: string): Promise<string> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;

    socket.setTimeout(10000);

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
        socket.write(SCHEMA_TRIGGER);

        // Wait for schema then call method
        setTimeout(() => {
          step = 5;

          // Build payload: item ID + favorite flag
          const payload = Buffer.concat([
            Buffer.from([0x84, 0x54]),  // Type marker
            ITEM_ID,
            Buffer.from([0x86, 0x87, 0x93, 0x0f, 0x01])  // favorite = true
          ]);

          const msg = buildNamedMethodCall(0x30, methodName, payload);
          socket.write(msg);
        }, 3000);
      }
      else if (step === 5 && (data[0] === 0x80 || data[0] === 0xc0)) {
        const text = data.toString('utf8');
        if (text.includes('MissingMethod')) {
          resolve('MissingMethod');
        } else if (text.includes('NotSupported')) {
          resolve('NotSupported');
        } else if (text.includes('Error')) {
          resolve('Error');
        } else if (text.includes('Success')) {
          resolve('SUCCESS!');
        } else {
          // Extract any readable message
          const match = text.match(/[A-Za-z]{3,}/g);
          resolve(match ? match.slice(0, 3).join(' ') : `Response: ${data.subarray(0, 20).toString('hex')}`);
        }
        socket.end();
      }
    });

    socket.on('timeout', () => {
      resolve(`Timeout (${totalReceived} bytes)`);
      socket.end();
    });

    socket.on('close', () => {
      if (step < 5) resolve('Closed early');
    });

    socket.on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('Testing named method calls for favorites:\n');

  for (const method of methodsToTry) {
    console.log(`  ${method}`);
    const result = await testMethod(method);
    console.log(`    → ${result}\n`);
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(console.error);
