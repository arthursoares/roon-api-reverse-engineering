/**
 * Quick test of named method call for favorites
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// Try calling TrackLite.IsFavorite.Set or similar patterns
const METHOD = 'Sooloos.Msg.Library.SetFavoriteRequest';

function buildRequest(msgId: number, typeName: string): Buffer {
  const nameBytes = Buffer.from(typeName);

  // Build a request with the item ID and favorite flag
  const payload = Buffer.concat([
    // Field: ItemId (84 = type marker, 54 = 'T')
    Buffer.from([0x24, 0x84, 0x06]),  // Field marker
    Buffer.from('ItemId'),
    Buffer.from([0x84, 0x54]),
    ITEM_ID,
    // Field: IsFavorite
    Buffer.from([0x1b, 0x86, 0x0a]),  // Bool field marker
    Buffer.from('IsFavorite'),
    Buffer.from([0x01]),  // true
    Buffer.from([0x05, 0x03, 0x05, 0x03])  // end markers
  ]);

  return Buffer.concat([
    Buffer.from([0x47, msgId & 0xff]),
    Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
    Buffer.from([nameBytes.length]),
    nameBytes,
    payload
  ]);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let schemaTimer: NodeJS.Timeout | null = null;

    socket.setTimeout(15000);

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
        console.log('Connected. Sending schema trigger...');
        step = 4;
        socket.write(SCHEMA_TRIGGER);

        // Send request after brief delay (don't wait for all schema)
        schemaTimer = setTimeout(() => {
          console.log(`Sending ${METHOD}...`);
          step = 5;
          const req = buildRequest(0x30, METHOD);
          console.log(`Request: ${req.toString('hex')}`);
          socket.write(req);
        }, 1500);
      }
      else if (step === 5) {
        console.log(`\nResponse (${data.length} bytes):`);
        console.log(`  Hex: ${data.subarray(0, 50).toString('hex')}`);

        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
        console.log(`  Text: ${text.substring(0, 100)}`);

        if (schemaTimer) clearTimeout(schemaTimer);
        socket.end();
      }
    });

    socket.on('timeout', () => {
      console.log('Timeout');
      if (schemaTimer) clearTimeout(schemaTimer);
      socket.end();
    });

    socket.on('close', () => {
      console.log('Done');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
