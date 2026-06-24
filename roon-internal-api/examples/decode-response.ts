/**
 * Decode the server response to understand what state we're in
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const CLIENT_BROKER_ID = crypto.randomBytes(16);
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildClientHello(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

function buildConnectRequest(): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex'));
  return Buffer.from(hex, 'hex');
}

// Build a proper favorite packet with incrementing message ID
function buildFavoritePacket(messageId: number, itemIdHex: string, favorite: boolean): Buffer {
  // Item ID from captured traffic
  const itemId = Buffer.from(itemIdHex, 'hex');

  return Buffer.concat([
    Buffer.from([0x43]),           // Message type (client request)
    Buffer.from([messageId & 0xff]), // Message ID
    Buffer.from([0x1b]),           // Operation code (27 = favorite)
    Buffer.from([0x32]),           // Unknown
    Buffer.from([0x84, 0x54]),     // Type marker
    itemId,                        // 19-byte item ID
    Buffer.from([0x83, 0xfa, 0xa4]), // Parameter marker
    Buffer.from([favorite ? 0x11 : 0x10]), // Boolean value
    Buffer.from([0x01])            // End marker
  ]);
}

async function debug(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let step = 0;
    let allData: Buffer[] = [];
    let messageId = 0;

    socket.setTimeout(15000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log(`Client Broker ID: ${CLIENT_BROKER_ID.toString('hex')}\n`);

      step = 1;
      socket.write(buildClientHello());
    });

    socket.on('data', (data) => {
      allData.push(data);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('Step 1: Hello acknowledged');
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Step 2: Session established');
          socket.write(buildConnectRequest());
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Step 3: ConnectRequest accepted\n');

        // Decode the response
        console.log('=== Decoding Server Response ===\n');
        const combined = Buffer.concat(allData);

        // Skip handshake bytes (6 + 22 = 28 bytes)
        const responseData = combined.subarray(28);
        console.log(`Response data: ${responseData.length} bytes\n`);

        // Parse messages
        let offset = 0;
        let msgNum = 1;
        while (offset < responseData.length) {
          const msgType = responseData[offset];
          const msgId = responseData[offset + 1];

          console.log(`--- Message ${msgNum} ---`);
          console.log(`Type: 0x${msgType.toString(16)}, ID: ${msgId}`);

          // Find type name (look for "Sooloos." pattern)
          const slice = responseData.subarray(offset, Math.min(offset + 200, responseData.length));
          const str = slice.toString('utf8');
          const match = str.match(/Sooloos\.[A-Za-z.]+/);
          if (match) {
            console.log(`Type: ${match[0]}`);
          }

          // Extract readable strings
          const readable = slice.toString('utf8').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
          console.log(`Content: ${readable.substring(0, 150)}...`);
          console.log('');

          // Simple heuristic: look for next message start (0x80 followed by small number)
          offset += 10; // Skip at least some bytes
          while (offset < responseData.length - 1) {
            if (responseData[offset] === 0x80 && responseData[offset + 1] < 10) {
              break;
            }
            offset++;
          }
          msgNum++;
          if (msgNum > 5) break; // Safety limit
        }

        // Now try sending favorite command
        console.log('=== Sending Favorite Command ===\n');
        messageId = 2; // Start at 2 since server used 1

        // Use the item ID from the capture
        const itemIdHex = '123f01162027273a55d64bbf4a85f335410e2f';
        const favPacket = buildFavoritePacket(messageId, itemIdHex, true);

        console.log(`Packet (${favPacket.length} bytes): ${favPacket.toString('hex')}`);
        socket.write(favPacket);
        step = 5;
      }
      else if (step === 5) {
        console.log('\n=== Favorite Response ===');
        console.log(`Length: ${data.length} bytes`);
        console.log(`Hex: ${data.toString('hex')}`);
        console.log(`Readable: ${data.toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);
        socket.end();
      }
    });

    socket.on('timeout', () => {
      console.log('\nTimeout - no response to favorite command');
      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', reject);
    socket.connect(PORT, HOST);
  });
}

debug().catch(console.error);
