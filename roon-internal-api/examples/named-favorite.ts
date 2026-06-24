/**
 * Try calling favorite using 0x47 named method format
 *
 * The ConnectRequest uses 0x47 with the method name embedded.
 * Maybe we can call FavoriteOrBan the same way.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Track ID from capture
const TRACK_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// Profile ID (sooid) - this is the profile GUID from schema trigger
const PROFILE_ID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

function buildNamedMethodCall(msgId: number, methodName: string, params: Buffer): Buffer {
  const nameBytes = Buffer.from(methodName);

  // Based on ConnectRequest format: 47 [msgId] 81 67 00 00 00 01 00 01 [len] [name] [params]
  // The 81 67 might be a length or type marker
  const header = Buffer.from([
    0x47,                        // Message type
    msgId & 0xff,                // Message ID
    0x81, 0x67,                  // Header bytes (copied from ConnectRequest)
    0x00, 0x00, 0x00, 0x01,      // Flags?
    0x00, 0x01,                  // More flags?
  ]);

  // Encode method name length
  let lenBytes: Buffer;
  if (nameBytes.length < 128) {
    lenBytes = Buffer.from([nameBytes.length]);
  } else {
    // Varint encoding for longer names
    const len = nameBytes.length;
    lenBytes = Buffer.from([0x81, len & 0x7f, (len >> 7) & 0x7f]);
  }

  return Buffer.concat([header, lenBytes, nameBytes, params]);
}

// Try different method names
const METHOD_NAMES = [
  'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)',
  'Sooloos.Msg.Library.FavoriteRequest',
  'Sooloos.Broker.Api.TrackLite::SetIsFavorite',
];

async function tryNamedMethods(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let methodIndex = 0;

    socket.setTimeout(25000);

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
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
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
        console.log('Connected. Triggering schema...');
        socket.write(SCHEMA_TRIGGER);

        // Try method calls after schema arrives
        setTimeout(() => {
          tryNextMethod();
        }, 3000);
      }
      else if (step === 5) {
        // Look for response
        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');

        console.log(`Response (${data.length} bytes):`);
        console.log(`  Hex: ${data.subarray(0, 50).toString('hex')}`);
        console.log(`  Text: ${text.substring(0, 80)}`);

        // Check for known patterns
        if (text.includes('Success')) {
          console.log('\n*** SUCCESS! ***');
          socket.end();
        } else if (text.includes('MissingMethod') || text.includes('Unknown')) {
          console.log('  (Method not found, trying next...)');
          setTimeout(() => tryNextMethod(), 1000);
        }
      }
    });

    function tryNextMethod() {
      if (methodIndex >= METHOD_NAMES.length) {
        console.log('\nAll methods tried. No success.');
        socket.end();
        return;
      }

      const methodName = METHOD_NAMES[methodIndex];
      console.log(`\nTrying method ${methodIndex + 1}: ${methodName.substring(0, 50)}...`);

      // Build parameters: profile ID, track, favorite state
      const params = Buffer.concat([
        // Profile sooid
        Buffer.from([0x24, 0x84, 0x07]),  // Field marker
        Buffer.from('Profile'),
        Buffer.from([0x10]),  // sooid type marker
        PROFILE_ID,
        // Track
        Buffer.from([0x24, 0x84, 0x05]),
        Buffer.from('Track'),
        Buffer.from([0x84, 0x54]),  // Type marker 'T'
        TRACK_ID,
        // Favorite state
        Buffer.from([0x1b, 0x84, 0x05]),
        Buffer.from('State'),
        Buffer.from([0x01]),  // Favorite = true
        Buffer.from([0x05, 0x03]),  // End markers
      ]);

      const msgId = 0x30 + methodIndex;
      const request = buildNamedMethodCall(msgId, methodName, params);
      console.log(`  Request: ${request.subarray(0, 50).toString('hex')}...`);

      step = 5;
      socket.write(request);
      methodIndex++;
    }

    socket.on('timeout', () => {
      console.log('\nTimeout');
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

tryNamedMethods().catch(console.error);
