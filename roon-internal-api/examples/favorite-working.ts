/**
 * WORKING Favorite Implementation
 *
 * Based on capture analysis, the complete flow is:
 * 1. Handshake (ROON magic exchange)
 * 2. ConnectRequest
 * 3. 0x42 schema trigger with profile GUID
 * 4. 0x06 method registration for FavoriteOrBan
 * 5. 0x43 favorite command
 *
 * Response format: c0 [msgId] 08 07 Success
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// Profile GUID from capture - triggers schema delivery
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// FavoriteOrBan method registration
const FAVORITE_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a466176' +
  '6f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65' +
  '722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661' +
  '766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Item ID (track to favorite) - from capture
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// Parameter marker from capture
const PARAM_MARKER = Buffer.from('868ef247', 'hex');

function buildFavoriteCommand(msgId: number, favorite: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([0x43, msgId & 0xff]),
    Buffer.from([0x1b, 0x2d]),  // Method index
    Buffer.from([0x84, 0x54]),  // Type marker (Track)
    ITEM_ID,
    PARAM_MARKER,
    Buffer.from([favorite ? 0x01 : 0x00])
  ]);
}

async function favorite(shouldFavorite: boolean): Promise<boolean> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let responseBuffer = Buffer.alloc(0);
    const msgId = 0x06;

    socket.setTimeout(30000);

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
      responseBuffer = Buffer.concat([responseBuffer, data]);

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
        console.log('1. Connected, sending schema trigger...');
        socket.write(SCHEMA_TRIGGER);

        setTimeout(() => {
          console.log('2. Registering FavoriteOrBan method...');
          socket.write(FAVORITE_REGISTRATION);

          setTimeout(() => {
            step = 5;
            responseBuffer = Buffer.alloc(0);
            const cmd = buildFavoriteCommand(msgId, shouldFavorite);
            console.log(`3. Sending ${shouldFavorite ? 'FAVORITE' : 'UNFAVORITE'} command...`);
            socket.write(cmd);
          }, 500);
        }, 3000);
      }
      else if (step === 5) {
        // Look for "c0 [msgId] 08 07 Success" pattern
        const successPattern = Buffer.from([0xc0, msgId, 0x08, 0x07]);
        const idx = responseBuffer.indexOf(successPattern);

        if (idx !== -1) {
          const responseText = responseBuffer.subarray(idx + 4, idx + 11).toString('utf8');
          if (responseText === 'Success') {
            console.log('4. SUCCESS! Track ' + (shouldFavorite ? 'favorited' : 'unfavorited') + '!');
            socket.end();
            resolve(true);
            return;
          }
        }

        // Check for error
        if (responseBuffer.toString('utf8').includes('MissingMethod')) {
          console.log('4. ERROR: MissingMethod');
          socket.end();
          resolve(false);
          return;
        }
      }
    });

    socket.on('timeout', () => {
      console.log('Timeout');
      socket.end();
      resolve(false);
    });

    socket.on('close', () => {
      // Check one more time for success in buffer
      const successPattern = Buffer.from([0xc0, msgId, 0x08, 0x07]);
      const idx = responseBuffer.indexOf(successPattern);
      if (idx !== -1 && responseBuffer.subarray(idx + 4, idx + 11).toString('utf8') === 'Success') {
        resolve(true);
      }
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      resolve(false);
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('='.repeat(50));
  console.log('Roon Favorite - Working Implementation');
  console.log('='.repeat(50));
  console.log('');

  const action = process.argv[2] === 'unfavorite' ? false : true;
  console.log(`Action: ${action ? 'FAVORITE' : 'UNFAVORITE'}`);
  console.log(`Track ID: ${ITEM_ID.toString('hex')}`);
  console.log('');

  const result = await favorite(action);
  console.log('');
  console.log(result ? 'Operation completed successfully!' : 'Operation failed');
}

main().catch(console.error);
