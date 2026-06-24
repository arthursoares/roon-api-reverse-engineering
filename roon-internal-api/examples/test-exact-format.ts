/**
 * Use exact ConnectRequest packet structure with different type names
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const CLIENT_BROKER_ID = crypto.randomBytes(16);
const MAGIC = Buffer.from('ROON');

// Original ConnectRequest: 470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964...
// Breaking it down:
// 47 01 - message type + ID
// 81 67 00 00 00 01 00 01 - header bytes
// 2c - length of type name (44 = 0x2c)
// "Sooloos.Msg.DistributedBroker.ConnectRequest" - type name
// 24 84 0e - field header? (24 = marker, 84 = type?, 0e = field name length)
// "ClientBrokerId" - field name (14 chars = 0x0e)
// [16 bytes] - broker ID value
// ... more fields ...
// 05 03 05 03 - end markers

function buildClientHello(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildConnectRequest(): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex'));
  return Buffer.from(hex, 'hex');
}

// Build a request using EXACT same structure as ConnectRequest
// Just change the type name
function buildRequest(msgId: number, typeName: string, fields: { marker: number; fieldType: number; name: string; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];

  // Message header (exact copy of ConnectRequest)
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));

  // Type name length + type name
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // Fields
  for (const field of fields) {
    parts.push(Buffer.from([field.marker, field.fieldType, field.name.length]));
    parts.push(Buffer.from(field.name));
    parts.push(field.value);
  }

  // End markers
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

async function test(): Promise<void> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 1;

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log('Connected\n');
      step = 1;
      socket.write(buildClientHello());
    });

    socket.on('data', (data) => {
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(buildConnectRequest());
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Session ready\n');
        runTests();
      }
      else if (step >= 4) {
        const respMsgId = data[1];
        const respType = data[0];
        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.').substring(0, 100);

        console.log(`\nResponse msgId=${respMsgId}, type=0x${respType.toString(16)}:`);
        console.log(`  ${types.length > 0 ? types.join(', ') : text}`);
        console.log(`  Hex: ${data.toString('hex').substring(0, 80)}`);
      }
    });

    async function runTests(): Promise<void> {
      // Test 1: Try a minimal request with no fields
      msgId++;
      console.log(`\n=== Test 1: No fields ===`);
      const typeName1 = 'Sooloos.Msg.Library.VirtualAlbumQueryRequest';
      const req1 = buildRequest(msgId, typeName1, []);
      console.log(`Type: ${typeName1}`);
      console.log(`Packet: ${req1.toString('hex')}`);
      socket.write(req1);
      await new Promise(r => setTimeout(r, 2000));

      // Test 2: With ClientBrokerId field (same as ConnectRequest)
      msgId++;
      console.log(`\n=== Test 2: With ClientBrokerId ===`);
      const typeName2 = 'Sooloos.Msg.Library.VirtualAlbumQueryRequest';
      const req2 = buildRequest(msgId, typeName2, [
        { marker: 0x24, fieldType: 0x84, name: 'ClientBrokerId', value: CLIENT_BROKER_ID }
      ]);
      console.log(`Packet: ${req2.toString('hex')}`);
      socket.write(req2);
      await new Promise(r => setTimeout(r, 2000));

      // Test 3: Try a simpler type name
      msgId++;
      console.log(`\n=== Test 3: Simpler type ===`);
      const typeName3 = 'Sooloos.Msg.Library.GetInfoRequest';
      const req3 = buildRequest(msgId, typeName3, []);
      console.log(`Type: ${typeName3}`);
      console.log(`Packet: ${req3.toString('hex')}`);
      socket.write(req3);
      await new Promise(r => setTimeout(r, 2000));

      // Verify connection still works
      console.log('\n=== Keepalive check ===');
      socket.write(Buffer.from([0x41, 0xff, 0x00]));
      await new Promise(r => setTimeout(r, 1000));

      socket.end();
    }

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
