/**
 * Try specific favorite-related method patterns
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

function buildMethodCall(msgId: number, typeName: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));
  return Buffer.concat(parts);
}

async function testMethod(socket: net.Socket, msgId: number, typeName: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), 1000);

    const handler = (data: Buffer) => {
      clearTimeout(timeout);
      socket.removeListener('data', handler);

      const typeMatch = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/);
      const respType = typeMatch ? typeMatch[0] : 'unknown';

      if (respType.includes('NotSupported')) {
        resolve('not supported');
      } else if (respType.includes('Error')) {
        resolve(`error: ${respType}`);
      } else {
        resolve(`OK: ${respType} (${data.length}b)`);
      }
    };

    socket.on('data', handler);
    socket.write(buildMethodCall(msgId, typeName));
  });
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(60000);

    socket.on('connect', () => {
      console.log('Connected\n');
      step = 1;
      socket.write(buildClientHello(clientBrokerId));
    });

    socket.on('data', async (data) => {
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
        await runTests(socket);
        socket.end();
      }
    });

    socket.on('close', () => {
      console.log('\nDone');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

async function runTests(socket: net.Socket): Promise<void> {
  let msgId = 10;

  // Based on documented patterns, try variations
  const methods = [
    // IsFavorite pattern (from documented types)
    'Sooloos.Msg.Library.SetIsFavoriteRequest',
    'Sooloos.Msg.Selection.SetIsFavoriteRequest',

    // Following ConnectRequest pattern
    'Sooloos.Msg.Library.SetFavoriteRequest',
    'Sooloos.Msg.Favorites.SetRequest',

    // Try browsing patterns
    'Sooloos.Msg.Library.BrowseAlbumsRequest',
    'Sooloos.Msg.Library.SearchRequest',

    // Try profile/zone access (these are fundamental)
    'Sooloos.Msg.Profile.GetCurrentRequest',
    'Sooloos.Msg.Zone.GetAllRequest',
    'Sooloos.Msg.System.GetInfoRequest',

    // Try DistributedBroker patterns (since ConnectRequest worked)
    'Sooloos.Msg.DistributedBroker.PingRequest',
    'Sooloos.Msg.DistributedBroker.GetServicesRequest',
    'Sooloos.Msg.DistributedBroker.SubscribeRequest',
  ];

  console.log('Testing favorite-related and fundamental methods:\n');

  for (const method of methods) {
    msgId++;
    const result = await testMethod(socket, msgId, method);
    const shortName = method.replace('Sooloos.Msg.', '').replace('Request', '');
    console.log(`  ${shortName.padEnd(40)} → ${result}`);

    // Small delay between requests
    await new Promise(r => setTimeout(r, 200));
  }
}

test().catch(console.error);
