/**
 * Test different message types to find schema delivery or setup mechanism
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

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 1;

    socket.setTimeout(60000);

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
          console.log('Hello acked');
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Session established');
          socket.write(buildConnectRequest(clientBrokerId));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log(`ConnectRequest accepted (${data.length} bytes)\n`);
        console.log('=== Testing Message Types ===\n');
        testMessageTypes();
      }
      else if (step === 4) {
        // Got a response to one of our test messages
        console.log(`  Response: ${data.length} bytes`);
        console.log(`  Hex: ${data.toString('hex').substring(0, 60)}${data.length > 30 ? '...' : ''}`);
        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
        if (text.length > 10) {
          console.log(`  Text: ${text.substring(0, 100)}`);
        }
        console.log('');
      }
    });

    async function testMessageTypes(): Promise<void> {
      // Test different message types: 0x40-0x4F
      const typesToTest = [
        { type: 0x40, name: '@', payload: Buffer.from([0x00]) },
        { type: 0x42, name: 'B', payload: Buffer.from([0x00]) },
        { type: 0x44, name: 'D', payload: Buffer.from([0x00]) },
        { type: 0x45, name: 'E', payload: Buffer.from([0x00]) },
        { type: 0x46, name: 'F', payload: Buffer.from([0x00]) },
        { type: 0x48, name: 'H', payload: Buffer.from([0x00]) },
        { type: 0x49, name: 'I', payload: Buffer.from([0x00]) },
        { type: 0x4A, name: 'J', payload: Buffer.from([0x00]) },
        // Try a few with the same header style as ConnectRequest
        { type: 0x47, name: 'G2', payload: Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      ];

      for (const { type, name, payload } of typesToTest) {
        msgId = (msgId + 1) & 0xff;
        const packet = Buffer.concat([
          Buffer.from([type, msgId]),
          payload
        ]);

        console.log(`Testing type 0x${type.toString(16)} ('${name}'): ${packet.toString('hex')}`);
        socket.write(packet);

        await new Promise(r => setTimeout(r, 1000));
      }

      console.log('\n=== Trying to request schema explicitly ===\n');

      // Try sending a message that might request schema
      // Using ConnectRequest-like format but different type name
      const schemaRequest = buildSchemaRequest(clientBrokerId, msgId + 1);
      console.log(`Schema request: ${schemaRequest.toString('hex').substring(0, 80)}...`);
      socket.write(schemaRequest);

      await new Promise(r => setTimeout(r, 3000));

      console.log('Done testing. Checking if connection is alive...');
      socket.write(Buffer.from([0x41, 0xff, 0x00]));

      await new Promise(r => setTimeout(r, 2000));
      socket.end();
    }

    socket.on('timeout', () => {
      console.log('Timeout');
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

function buildSchemaRequest(clientBrokerId: Buffer, msgId: number): Buffer {
  // Try to construct a message requesting schema
  // Using similar format to ConnectRequest but with a different type
  const typeName = 'Sooloos.Msg.DistributedBroker.SchemaRequest';

  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));
  // Minimal fields
  parts.push(Buffer.from([0x24, 0x84, 0x0e]));
  parts.push(Buffer.from('ClientBrokerId'));
  parts.push(clientBrokerId);
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

test().catch(console.error);
