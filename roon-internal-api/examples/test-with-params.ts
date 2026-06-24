/**
 * Try VirtualAlbumQuery with parameters
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

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

// Build VirtualAlbumQuery with minimal parameters
function buildVirtualAlbumQuery(msgId: number): Buffer {
  const typeName = 'Sooloos.Msg.Library.VirtualAlbumQueryRequest';
  const parts: Buffer[] = [];

  // Header
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // Try adding a simple field like in ConnectRequest format
  // Field: ProfileId (16 bytes, using a zero/null ID)
  parts.push(Buffer.from([0x24, 0x84, 'ProfileId'.length]));
  parts.push(Buffer.from('ProfileId'));
  parts.push(Buffer.alloc(16)); // Zero profile ID

  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

// Build with different field patterns
function buildQueryV2(msgId: number): Buffer {
  const typeName = 'Sooloos.Msg.Library.VirtualAlbumQueryRequest';
  const parts: Buffer[] = [];

  // Header
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // Try: Limit field (integer)
  parts.push(Buffer.from([0x1b, 0x81, 'Limit'.length]));
  parts.push(Buffer.from('Limit'));
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0x02])); // "10" as string
  parts.push(Buffer.from('10'));

  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

// Try minimal request with Query as field
function buildQueryV3(msgId: number): Buffer {
  const typeName = 'Sooloos.Msg.Library.VirtualAlbumQueryRequest';
  const parts: Buffer[] = [];

  // Header
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // Empty struct end marker
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 10;

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log('Connected\n');
      step = 1;
      socket.write(buildClientHello(clientBrokerId));
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
          socket.write(buildConnectRequest(clientBrokerId));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Session ready\n');
        runTests();
      }
      else if (step >= 4) {
        const respMsgId = data[1];
        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        console.log(`Response for msgId=${respMsgId}:`);
        console.log(`  Types: ${types.join(', ')}`);
        console.log(`  Size: ${data.length} bytes`);
        console.log(`  Hex: ${data.toString('hex').substring(0, 100)}`);
        console.log('');
      }
    });

    async function runTests(): Promise<void> {
      console.log('Testing VirtualAlbumQuery with different parameter patterns:\n');

      // Test v1: with ProfileId field
      msgId++;
      console.log(`V1 (with ProfileId): msgId=${msgId}`);
      const q1 = buildVirtualAlbumQuery(msgId);
      console.log(`  Packet: ${q1.toString('hex')}\n`);
      socket.write(q1);
      await new Promise(r => setTimeout(r, 2000));

      // Test v2: with Limit field
      msgId++;
      console.log(`V2 (with Limit): msgId=${msgId}`);
      const q2 = buildQueryV2(msgId);
      console.log(`  Packet: ${q2.toString('hex')}\n`);
      socket.write(q2);
      await new Promise(r => setTimeout(r, 2000));

      // Test v3: empty (baseline)
      msgId++;
      console.log(`V3 (empty): msgId=${msgId}`);
      const q3 = buildQueryV3(msgId);
      console.log(`  Packet: ${q3.toString('hex')}\n`);
      socket.write(q3);
      await new Promise(r => setTimeout(r, 2000));

      console.log('Done');
      socket.end();
    }

    socket.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
