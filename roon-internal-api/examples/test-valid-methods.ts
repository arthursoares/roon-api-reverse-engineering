/**
 * Try finding valid method names and parameters
 * We know 0x47 format works - now find the right methods
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

function buildMethodCall(msgId: number, typeName: string, fields: { name: string; type: number; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];

  // Message header
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));

  // Type name
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // Fields (using format from captured data)
  for (const field of fields) {
    // Field header: position marker + type indicator + name length
    parts.push(Buffer.from([0x24, 0x84, field.name.length]));
    parts.push(Buffer.from(field.name));
    if (field.type === 0x84) {
      // Raw bytes (like broker ID)
      parts.push(field.value);
    } else if (field.type === 0x81) {
      // String value
      parts.push(Buffer.from([0x00, 0x00, 0x00, field.value.length]));
      parts.push(field.value);
    }
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
        console.log(`ConnectRequest accepted\n`);
        testMethods();
      }
      else if (step === 4) {
        // Decode response
        const respType = data.subarray(0, 2).toString('hex');
        const typeNameMatch = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/);
        const typeName = typeNameMatch ? typeNameMatch[0] : 'unknown';

        console.log(`  Response type: ${respType}, ${data.length} bytes`);
        console.log(`  Type name: ${typeName}`);

        // Check for success/error
        const text = data.toString('utf8');
        if (text.includes('NotSupported')) {
          console.log(`  Status: NOT SUPPORTED`);
        } else if (text.includes('Error')) {
          console.log(`  Status: ERROR`);
        } else if (text.includes('Success')) {
          console.log(`  Status: SUCCESS!`);
        } else {
          console.log(`  Text: ${text.replace(/[^\x20-\x7E]/g, '.').substring(0, 80)}`);
        }
        console.log('');
      }
    });

    async function testMethods(): Promise<void> {
      console.log('=== Testing Method Names ===\n');

      // Based on documented types, try various message patterns
      const methodsToTry = [
        // Try message-style names (Msg namespace)
        'Sooloos.Msg.Profiles.GetProfilesRequest',
        'Sooloos.Msg.Zones.GetZonesRequest',
        'Sooloos.Msg.Library.BrowseRequest',
        'Sooloos.Msg.Favorites.SetFavoriteRequest',

        // Try API-style names
        'Sooloos.Broker.Api.Profile.GetCurrent',
        'Sooloos.Broker.Api.Zone.List',

        // Try without "Broker"
        'Sooloos.Api.Library.SetFavorite',

        // Try shorter names
        'Sooloos.SetFavorite',
        'Sooloos.Favorite',

        // Check if there's a "browse" or "query" type
        'Sooloos.Msg.Browse.BrowseRequest',
        'Sooloos.Msg.Query.QueryRequest',

        // Try ping/echo patterns
        'Sooloos.Msg.Echo.EchoRequest',
        'Sooloos.Msg.Core.PingRequest',
      ];

      for (const method of methodsToTry) {
        msgId++;
        console.log(`Trying: ${method}`);

        const packet = buildMethodCall(msgId, method, []);
        socket.write(packet);

        await new Promise(r => setTimeout(r, 800));
      }

      // Final keepalive
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
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
