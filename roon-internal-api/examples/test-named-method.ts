/**
 * Try calling methods using full type names (0x47 format) instead of method indices (0x43 format)
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

// Build a method call using the 0x47 format with full type name
function buildNamedMethodCall(msgId: number, typeName: string, fields: { name: string; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];

  // Message header (same as ConnectRequest)
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));

  // Type name with length prefix
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // Fields
  for (const field of fields) {
    // Field marker + type (using simple patterns from ConnectRequest)
    parts.push(Buffer.from([0x24, 0x84, field.name.length]));
    parts.push(Buffer.from(field.name));
    parts.push(field.value);
  }

  // End markers
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 1;

    socket.setTimeout(15000);

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
        testNamedMethods();
      }
      else if (step === 4) {
        console.log(`Response: ${data.length} bytes`);
        console.log(`  Hex: ${data.toString('hex').substring(0, 80)}${data.length > 40 ? '...' : ''}`);
        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
        console.log(`  Text: ${text.substring(0, 100)}`);
        console.log('');
      }
    });

    async function testNamedMethods(): Promise<void> {
      console.log('=== Testing Named Method Calls ===\n');

      // Try various type names that might be valid requests
      const testCalls = [
        // Based on documented API methods
        'Sooloos.Broker.Api.Library.GetProfiles',
        'Sooloos.Broker.Api.Library.GetZones',
        'Sooloos.Msg.DistributedBroker.PingRequest',
        'Sooloos.Msg.DistributedBroker.GetSchemaRequest',
        'Sooloos.Broker.Api.ProfilesRequest',
      ];

      for (const typeName of testCalls) {
        msgId++;
        console.log(`Trying: ${typeName}`);

        const packet = buildNamedMethodCall(msgId, typeName, []);
        console.log(`  Packet: ${packet.toString('hex').substring(0, 60)}...`);
        socket.write(packet);

        await new Promise(r => setTimeout(r, 1500));
      }

      // Also try the item ID based format
      console.log('\nTrying item-based request...');
      msgId++;

      // Build a request that includes the item ID
      const itemId = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');
      const setFavoriteRequest = buildNamedMethodCall(msgId, 'Sooloos.Broker.Api.Library.SetFavorite', [
        { name: 'ItemId', value: itemId },
        { name: 'Favorite', value: Buffer.from([0x11]) }, // true
      ]);
      console.log(`  Packet: ${setFavoriteRequest.toString('hex').substring(0, 80)}...`);
      socket.write(setFavoriteRequest);

      await new Promise(r => setTimeout(r, 2000));

      // Final keepalive to check connection
      console.log('Sending keepalive...');
      socket.write(Buffer.from([0x41, 0xff, 0x00]));
      await new Promise(r => setTimeout(r, 1000));

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

test().catch(console.error);
