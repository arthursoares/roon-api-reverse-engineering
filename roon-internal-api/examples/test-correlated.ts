/**
 * Properly correlate requests and responses by message ID
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

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  const pendingRequests = new Map<number, string>();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 10; // Start at 10 to distinguish from handshake

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
        // Extract message ID from response
        const respType = data[0];
        const respMsgId = data[1];

        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        const typeName = types[0] || '(no type)';
        const reqName = pendingRequests.get(respMsgId) || '(unknown request)';

        console.log(`  Response msgId=${respMsgId} (req: ${reqName})`);
        console.log(`    Type: 0x${respType.toString(16)}, ${data.length}b`);
        console.log(`    Content: ${typeName}`);

        // Dump hex for interesting responses
        if (typeName !== 'Sooloos.Msg.Common.NotSupportedErrorResponse') {
          console.log(`    Hex: ${data.toString('hex').substring(0, 80)}...`);
        }
        console.log('');

        pendingRequests.delete(respMsgId);
      }
    });

    async function runTests(): Promise<void> {
      // Test a few specific methods one at a time
      const methods = [
        'Sooloos.Msg.Library.VirtualAlbumQueryRequest',
        'Sooloos.Msg.Transport.PlayPlaylistRequest',
        'Sooloos.Msg.Transport.GetZonesRequest',
        'Sooloos.Msg.Profiles.GetProfilesRequest',
        'Sooloos.Msg.DistributedBroker.GetServicesRequest',
      ];

      console.log('Testing methods one at a time:\n');

      for (const method of methods) {
        msgId++;
        const shortName = method.replace('Sooloos.Msg.', '').replace('Request', '');
        pendingRequests.set(msgId, shortName);

        console.log(`Sending msgId=${msgId}: ${shortName}`);
        socket.write(buildMethodCall(msgId, method));

        // Wait for response
        await new Promise(r => setTimeout(r, 2000));
      }

      // Check remaining pending
      console.log('\nPending requests (no response):');
      for (const [id, name] of pendingRequests) {
        console.log(`  msgId=${id}: ${name}`);
      }

      console.log('\nDone');
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
