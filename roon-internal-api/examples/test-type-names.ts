/**
 * Test which type names are recognized by the server
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildMethodCall(msgId: number, typeName: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));
  return Buffer.concat(parts);
}

async function testConnection(method: string): Promise<string> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let result = 'timeout';

    socket.setTimeout(10000);

    socket.on('connect', () => {
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
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
        // Wait for server to be fully ready
        setTimeout(() => {
          socket.write(buildMethodCall(0x50, method));
        }, 500);
      }
      else if (step === 4) {
        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g);
        if (types && types.length > 0) {
          result = types[0]!.replace('Sooloos.Msg.', '').replace('Response', '');
        } else {
          result = `unknown (${data.length}b)`;
        }
        socket.end();
      }
    });

    socket.on('timeout', () => {
      socket.end();
    });

    socket.on('close', () => {
      resolve(result);
    });

    socket.on('error', () => {
      resolve('error');
    });

    socket.connect(PORT, HOST);
  });
}

async function main(): Promise<void> {
  // Test just a few key type names
  const typesToTest = [
    // Known to get response (from rapid test)
    'Sooloos.Msg.Library.VirtualAlbumQueryRequest',
    // Favorite-related
    'Sooloos.Msg.Library.SetFavoriteRequest',
    'Sooloos.Msg.Selection.SetFavoriteRequest',
  ];

  console.log('Testing type names (one per connection):\n');

  for (const type of typesToTest) {
    const shortName = type.replace('Sooloos.Msg.', '').replace('Request', '');
    const result = await testConnection(type);
    console.log(`  ${shortName.padEnd(40)} → ${result}`);

    // Longer delay between connections to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\nDone');
}

main().catch(console.error);
