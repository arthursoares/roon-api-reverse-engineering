/**
 * Debug the complete flow with detailed logging
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

// ConnectRequest template (placeholder for client ID)
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// Schema trigger with profile GUID
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// FavoriteOrBan method registration
const FAV_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Favorite command
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');
const PARAM_MARKER = Buffer.from('868ef247', 'hex');

function buildFavoriteCommand(msgId: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x43, msgId & 0xff]),
    Buffer.from([0x1b, 0x2d]),  // Method index
    Buffer.from([0x84, 0x54]),  // Type marker
    ITEM_ID,
    PARAM_MARKER,
    Buffer.from([0x01])  // favorite = true
  ]);
}

async function debug(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client Broker ID: ${clientBrokerId.toString('hex')}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;
    let messageCount = 0;

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log('\n[CONNECT] Connected to server');
      step = 1;
      const handshake1 = Buffer.concat([
        MAGIC,
        Buffer.from([0x01, 0x04]),
        SERVER_BROKER_ID,
        clientBrokerId
      ]);
      console.log(`[SEND] Step 1 - Handshake init (${handshake1.length} bytes)`);
      console.log(`       ${handshake1.toString('hex')}`);
      socket.write(handshake1);
    });

    socket.on('data', (data) => {
      totalReceived += data.length;
      messageCount++;

      console.log(`\n[RECV #${messageCount}] ${data.length} bytes (total: ${totalReceived})`);
      console.log(`       First 60: ${data.subarray(0, 60).toString('hex')}`);

      // Check for ROON magic
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
        const flags = data.length >= 6 ? data.subarray(4, 6).toString('hex') : 'N/A';
        console.log(`       ROON packet, flags: ${flags}`);

        if (data.length >= 6) {
          const code = data[5];

          if (step === 1 && code === 0x80) {
            console.log('       -> Handshake ACK received');
            step = 2;
            const handshake2 = Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
            console.log(`[SEND] Step 2 - Protocol request (${handshake2.length} bytes)`);
            socket.write(handshake2);
          }
          else if (step === 2 && code === 0x82) {
            console.log('       -> Session established!');
            if (data.length >= 22) {
              const sessionId = data.subarray(6, 22);
              console.log(`       Session ID: ${sessionId.toString('hex')}`);
            }
            step = 3;
            const connectReq = Buffer.from(
              CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
              'hex'
            );
            console.log(`[SEND] Step 3 - ConnectRequest (${connectReq.length} bytes)`);
            console.log(`       First 60: ${connectReq.subarray(0, 60).toString('hex')}`);
            socket.write(connectReq);
          }
        }
      }
      // Non-ROON message (protocol messages start with type byte)
      else {
        const msgType = data[0];
        console.log(`       Message type: 0x${msgType.toString(16)}`);

        if (step === 3 && msgType === 0x80) {
          console.log('       -> ConnectRequest accepted!');
          step = 4;

          console.log(`[SEND] Step 4 - Schema trigger (${SCHEMA_TRIGGER.length} bytes)`);
          console.log(`       ${SCHEMA_TRIGGER.toString('hex')}`);
          socket.write(SCHEMA_TRIGGER);

          // Wait for schema, then register and send command
          setTimeout(() => {
            console.log(`\n[INFO] Received ${totalReceived} bytes of schema data`);

            console.log(`[SEND] Step 5 - Method registration (${FAV_REGISTRATION.length} bytes)`);
            socket.write(FAV_REGISTRATION);

            setTimeout(() => {
              step = 6;
              const cmd = buildFavoriteCommand(0x06);
              console.log(`[SEND] Step 6 - Favorite command (${cmd.length} bytes)`);
              console.log(`       ${cmd.toString('hex')}`);
              socket.write(cmd);
            }, 500);
          }, 3000);
        }
        else if (step === 6) {
          // Look for response to our command
          const hex = data.toString('hex');
          const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');

          if (hex.includes('c006')) {
            const idx = hex.indexOf('c006');
            console.log(`       Found response at index ${idx/2}: ${hex.substring(idx, idx + 30)}`);
          }

          if (text.includes('Success')) {
            console.log('\n*** SUCCESS! Track favorited! ***\n');
            socket.end();
          }
          else if (text.includes('MissingMethod')) {
            console.log('\n*** ERROR: MissingMethod ***\n');
            socket.end();
          }
        }
      }
    });

    socket.on('timeout', () => {
      console.log(`\n[TIMEOUT] at step ${step}, received ${totalReceived} bytes total`);
      socket.end();
    });

    socket.on('close', () => {
      console.log('\n[CLOSE] Connection closed');
      resolve();
    });

    socket.on('error', (err) => {
      console.error(`\n[ERROR] ${err.message}`);
      resolve();
    });

    socket.connect(PORT, HOST);
  });
}

console.log('='.repeat(60));
console.log('Roon Protocol Debug');
console.log('='.repeat(60));

debug().catch(console.error);
