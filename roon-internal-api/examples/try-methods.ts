/**
 * Try multiple method registration formats to see which one works
 *
 * The 0x06 message might need a specific format to get a response.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Profile ID from schema trigger
const PROFILE_ID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Track ID from capture
const TRACK_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

// Different message formats to try
function buildMessages(): Array<{name: string, data: Buffer}> {
  const messages: Array<{name: string, data: Buffer}> = [];

  // 1. Original 0x06 registration format
  messages.push({
    name: '0x06 FavoriteOrBan registration (original)',
    data: Buffer.from(
      '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
      'hex'
    )
  });

  // 2. Original 0x43 command
  messages.push({
    name: '0x43 favorite command (original)',
    data: Buffer.from('43031b2d8454123f01162027273a55d64bbf4a85f335410e2f868ef24701', 'hex')
  });

  // 3. Try 0x43 with profile ID included
  const cmdWithProfile = Buffer.concat([
    Buffer.from([0x43, 0x10]),  // Command type, msg ID
    Buffer.from([0x10]),        // Profile marker
    PROFILE_ID,                  // Profile ID
    Buffer.from([0x1b, 0x2d]),  // Method index
    Buffer.from([0x84, 0x54]),  // Track type
    TRACK_ID,
    Buffer.from([0x01]),        // Favorite = true
    Buffer.from([0x05, 0x03])   // End
  ]);
  messages.push({name: '0x43 with profile ID', data: cmdWithProfile});

  // 4. Try simple property request format (like getting AlbumCount)
  // Message type 0x42 might be for subscription/property access
  const propRequest = Buffer.concat([
    Buffer.from([0x42, 0x20]),  // Type, msg ID
    Buffer.from([0x10]),        // Profile marker
    PROFILE_ID,
    Buffer.from([0x84, 0x54]),  // Track type
    TRACK_ID,
    Buffer.from([0x81, 0x0b]),  // Property name length + marker
    Buffer.from('IsFavorite'),
    Buffer.from([0x05, 0x03])
  ]);
  messages.push({name: '0x42 IsFavorite property', data: propRequest});

  // 5. Try using the 0x07 format (schema-like) for method call
  const schemaCall = Buffer.concat([
    Buffer.from([0x07, 0x30]),  // Type, msg ID
    PROFILE_ID,                  // Profile
    Buffer.from([0x84, 0x54]),  // Track type
    TRACK_ID,
    Buffer.from([0x01])         // Favorite
  ]);
  messages.push({name: '0x07 schema-style call', data: schemaCall});

  return messages;
}

async function tryMessages(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client ID: ${clientBrokerId.toString('hex')}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    const messages = buildMessages();
    let currentMsg = 0;
    let postSendData = Buffer.alloc(0);

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

        setTimeout(() => sendNextMessage(), 3000);
      }
      else if (step === 5) {
        postSendData = Buffer.concat([postSendData, data]);

        // Check for any response to our message
        const msgType = data[0];
        if (msgType >= 0x80 && msgType !== 0x80) {  // 0x80 might be keepalive
          console.log(`  Response type 0x${msgType.toString(16)}, ${data.length} bytes`);
          const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
          console.log(`  Text: ${text.substring(0, 60)}`);
        }

        // Look for c0/80 + msgId patterns
        for (let i = 0; i < Math.min(data.length - 1, 50); i++) {
          if ((data[i] === 0xc0 || data[i] === 0x80) && data[i + 1] < 0x40) {
            const respType = data[i];
            const nextBytes = data.subarray(i, Math.min(i + 15, data.length));
            console.log(`  Found ${respType === 0xc0 ? 'callback' : 'response'} pattern: ${nextBytes.toString('hex')}`);
          }
        }
      }
    });

    function sendNextMessage() {
      if (currentMsg >= messages.length) {
        console.log('\nAll messages sent. Waiting for any late responses...');
        setTimeout(() => socket.end(), 5000);
        return;
      }

      const msg = messages[currentMsg];
      console.log(`\n[${currentMsg + 1}/${messages.length}] Sending: ${msg.name}`);
      console.log(`  Hex: ${msg.data.toString('hex').substring(0, 60)}...`);

      step = 5;
      postSendData = Buffer.alloc(0);
      socket.write(msg.data);

      currentMsg++;
      setTimeout(sendNextMessage, 2000);
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

tryMessages().catch(console.error);
