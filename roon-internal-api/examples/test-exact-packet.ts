/**
 * Test sending exact captured packet formats
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// Exact favorite packet from capture (with original item ID)
const FAVORITE_PACKET_TEMPLATE = '43XX1b328454123f01162027273a55d64bbf4a85f335410e2f83faa41101';

function buildClientHello(clientBrokerId: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

function buildConnectRequest(clientBrokerId: Buffer): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex'));
  return Buffer.from(hex, 'hex');
}

function buildFavoritePacket(msgId: number): Buffer {
  const hex = FAVORITE_PACKET_TEMPLATE.replace('XX', msgId.toString(16).padStart(2, '0'));
  return Buffer.from(hex, 'hex');
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let allData: Buffer[] = [];

    socket.setTimeout(15000);

    socket.on('connect', () => {
      console.log('Connected. Client Broker ID:', clientBrokerId.toString('hex'));
      console.log('');
      step = 1;
      socket.write(buildClientHello(clientBrokerId));
    });

    socket.on('data', (data) => {
      allData.push(data);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('Step 1: Hello acked');
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Step 2: Session established');
          socket.write(buildConnectRequest(clientBrokerId));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Step 3: ConnectRequest accepted');
        console.log(`        Received ${data.length} bytes\n`);

        // Analyze the response in detail
        console.log('=== Analyzing Server Messages ===\n');
        const response = Buffer.concat(allData).subarray(28); // Skip handshake

        let offset = 0;
        while (offset < response.length) {
          const msgType = response[offset];
          const msgId = response[offset + 1];

          console.log(`Message at offset ${offset}:`);
          console.log(`  Type: 0x${msgType.toString(16)}, MsgID: ${msgId}`);

          // Extract readable text
          const slice = response.subarray(offset, Math.min(offset + 100, response.length));
          const text = slice.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
          console.log(`  Preview: ${text.substring(0, 80)}`);
          console.log('');

          // Find next message (0x80 followed by small number)
          const searchStart = offset + 10;
          let found = false;
          for (let i = searchStart; i < response.length - 1; i++) {
            if (response[i] === 0x80 && response[i + 1] < 10) {
              offset = i;
              found = true;
              break;
            }
          }
          if (!found) break;
        }

        // Now try sending the favorite packet
        console.log('=== Sending Exact Captured Favorite Packet ===\n');
        const favPacket = buildFavoritePacket(0x15); // Use original msg ID
        console.log(`Packet: ${favPacket.toString('hex')}`);
        console.log(`Length: ${favPacket.length} bytes`);

        // Annotate the packet
        console.log('\nPacket breakdown:');
        console.log(`  43      : Message type (client command)`);
        console.log(`  15      : Message ID`);
        console.log(`  1b      : Opcode (0x1b = 27)`);
        console.log(`  32      : Unknown (0x32 = 50)`);
        console.log(`  84 54   : Type marker`);
        console.log(`  12 3f.. : Item ID (19 bytes)`);
        console.log(`  83 fa a4: Parameter type marker`);
        console.log(`  11      : Boolean true (favorite)`);
        console.log(`  01      : End marker`);

        socket.write(favPacket);
        step = 5;
      }
      else if (step === 5) {
        console.log('\n=== Got Response! ===');
        console.log(`Length: ${data.length} bytes`);
        console.log(`Hex: ${data.toString('hex')}`);
        console.log(`Text: ${data.toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);
        socket.end();
      }
    });

    socket.on('timeout', () => {
      console.log('\n=== Timeout waiting for favorite response ===');

      // Try a keepalive to confirm connection is alive
      console.log('Sending keepalive to confirm connection...');
      socket.write(Buffer.from([0x41, 0x20, 0x00]));
      step = 6;

      setTimeout(() => socket.end(), 2000);
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
