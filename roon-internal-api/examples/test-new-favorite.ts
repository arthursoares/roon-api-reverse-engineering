/**
 * Test the correct favorite packet format from fresh capture
 *
 * Format: 43 [msgId] 1b 2d 84 54 [19-byte itemId] 86 87 93 0f [00/01]
 * - 00 = unfavorite
 * - 01 = favorite
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// Item ID from the capture (same track you favorited)
const ITEM_ID = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');

function buildFavoritePacket(msgId: number, favorite: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([0x43]),           // Message type
    Buffer.from([msgId & 0xff]),   // Message ID
    Buffer.from([0x1b]),           // Opcode (27)
    Buffer.from([0x2d]),           // NEW: was 0x32, now 0x2d
    Buffer.from([0x84, 0x54]),     // Type marker
    ITEM_ID,                       // 19-byte item ID
    Buffer.from([0x86, 0x87, 0x93, 0x0f]), // NEW parameter marker
    Buffer.from([favorite ? 0x01 : 0x00])  // NEW: 01=favorite, 00=unfavorite
  ]);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(15000);

    socket.on('connect', () => {
      console.log('Connected\n');
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('1. Hello acked');
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('2. Session established');
          socket.write(Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          ));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('3. ConnectRequest accepted\n');

        // Send favorite command after short delay
        setTimeout(() => {
          const favPacket = buildFavoritePacket(0x30, true);
          console.log('4. Sending FAVORITE command (new format):');
          console.log(`   Packet: ${favPacket.toString('hex')}`);
          console.log(`   Length: ${favPacket.length} bytes`);
          socket.write(favPacket);
        }, 500);
      }
      else if (step === 4) {
        console.log('\n5. GOT RESPONSE!');
        console.log(`   Length: ${data.length} bytes`);
        console.log(`   Hex: ${data.toString('hex')}`);
        console.log(`   Text: ${data.toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);

        // Close after receiving response
        setTimeout(() => socket.end(), 1000);
      }
    });

    socket.on('timeout', () => {
      console.log('\nTimeout - no response');
      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
