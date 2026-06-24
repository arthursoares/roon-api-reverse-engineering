/**
 * Try service registration patterns - maybe we need to register before using services
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
        // Log all responses
        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        const text = data.toString('utf8').replace(/[^\x20-\x7E]/g, '.').substring(0, 100);
        console.log(`  Response (${data.length}b): ${types[0] || text}`);
      }
    });

    async function runTests(): Promise<void> {
      // Test ONE request at a time with proper wait
      const methods = [
        // Registration patterns
        'Sooloos.Msg.Services.RegisterRequest',
        'Sooloos.Msg.DistributedBroker.RegisterServicesRequest',
        'Sooloos.Msg.DistributedBroker.GetSchemaRequest',

        // Try exact patterns from documented APIs
        // VirtualAlbumQuery is documented - try variations
        'Sooloos.Msg.Library.VirtualAlbumQueryRequest',
        'Sooloos.Msg.VirtualAlbumQueryRequest',

        // UnifiedSearch is documented
        'Sooloos.Msg.Library.UnifiedSearchRequest',
        'Sooloos.Msg.UnifiedSearchRequest',

        // GetTag is documented
        'Sooloos.Msg.Library.GetTagRequest',

        // Zone operations
        'Sooloos.Msg.Transport.GetZonesRequest',
        'Sooloos.Msg.Zones.GetRequest',
      ];

      console.log('Testing one at a time (2s wait each):\n');

      for (const method of methods) {
        msgId++;
        console.log(`\n${method}:`);
        socket.write(buildMethodCall(msgId, method));
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log('\nDone testing');
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
