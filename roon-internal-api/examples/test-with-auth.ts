/**
 * Test connection with the roon_auth_token
 *
 * The auth token might need to be included in:
 * 1. The ConnectRequest message
 * 2. A separate auth message
 * 3. Or it might just be for cloud API auth
 */

import * as net from 'net';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

// From HAR capture
const AUTH_TOKEN = 'REDACTED-AUTH-TOKEN';
const CLIENT_BROKER_UUID = '869e1fa3-a69d-412b-9b30-03e3a7813132';

// Convert UUID to binary format (like server broker ID)
function uuidToBuffer(uuid: string): Buffer {
  // Byte-swap first 3 sections (like the server broker ID)
  const parts = uuid.split('-');
  const swapped =
    parts[0].match(/../g)!.reverse().join('') +
    parts[1].match(/../g)!.reverse().join('') +
    parts[2].match(/../g)!.reverse().join('') +
    parts[3] + parts[4];
  return Buffer.from(swapped, 'hex');
}

const CLIENT_BROKER_ID = uuidToBuffer(CLIENT_BROKER_UUID);

console.log('Auth Token:', AUTH_TOKEN);
console.log('Client Broker ID (UUID):', CLIENT_BROKER_UUID);
console.log('Client Broker ID (hex):', CLIENT_BROKER_ID.toString('hex'));

// Note: AUTH_TOKEN could be used in a future auth field if needed
void AUTH_TOKEN;

// Original ConnectRequest (known working)
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// FavoriteOrBan command
const TRACK_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');
const FAV_COMMAND = Buffer.concat([
  Buffer.from([0x43, 0x06, 0x1b, 0x2d, 0x84, 0x54]),
  TRACK_ID,
  Buffer.from([0x86, 0x8e, 0xf2, 0x47, 0x01])
]);

async function testWithAuth(): Promise<void> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let postCommandData = Buffer.alloc(0);

    socket.setTimeout(25000);

    socket.on('connect', () => {
      console.log('\nConnected. Using captured client broker ID...');
      step = 1;

      // Use the SAME client broker ID from the HAR capture
      socket.write(Buffer.concat([
        MAGIC,
        Buffer.from([0x01, 0x04]),
        SERVER_BROKER_ID,
        CLIENT_BROKER_ID  // Use the exact client ID from capture
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
          console.log('Session established');

          // Use original working ConnectRequest but with captured client ID
          const req = Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace(
              'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
              CLIENT_BROKER_ID.toString('hex')
            ),
            'hex'
          );
          console.log(`ConnectRequest with captured client ID: ${CLIENT_BROKER_ID.toString('hex')}`);
          socket.write(req);
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('ConnectRequest accepted');
        console.log('Sending schema trigger...');
        socket.write(SCHEMA_TRIGGER);

        // Try favorite after schema
        setTimeout(() => {
          step = 5;
          postCommandData = Buffer.alloc(0);
          console.log('Sending favorite command...');
          socket.write(FAV_COMMAND);
        }, 4000);
      }
      else if (step === 5) {
        postCommandData = Buffer.concat([postCommandData, data]);

        // Look for response to msg 6
        const hex = data.toString('hex');
        if (hex.includes('c006')) {
          const idx = hex.indexOf('c006');
          console.log(`\n*** Found c006 response! ***`);
          console.log(`Context: ${hex.substring(idx, idx + 40)}`);

          const text = data.toString('utf8');
          if (text.includes('Success')) {
            console.log('*** SUCCESS! ***');
          }
        }
      }
    });

    socket.on('timeout', () => {
      console.log('\nTimeout');

      // Final check
      const text = postCommandData.toString('utf8');
      if (text.includes('Success')) {
        console.log('Success found in buffer!');
      }

      // Look for any c006 in collected data
      const hex = postCommandData.toString('hex');
      const idx = hex.indexOf('c006');
      if (idx >= 0) {
        console.log(`c006 at ${idx}: ${hex.substring(idx, idx + 30)}`);
      }

      socket.end();
    });

    socket.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

console.log('\n' + '='.repeat(50));
console.log('Testing with captured auth credentials');
console.log('='.repeat(50));

testWithAuth().catch(console.error);
