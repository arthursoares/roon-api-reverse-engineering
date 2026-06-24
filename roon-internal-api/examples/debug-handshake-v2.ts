/**
 * Debug handshake v2 - try different ProtocolHash to get schema
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const CLIENT_BROKER_ID = crypto.randomBytes(16);
const MAGIC = Buffer.from('ROON');

// Build ConnectRequest with custom protocol hash
function buildConnectRequest(clientBrokerId: Buffer, protocolHash: string): Buffer {
  const parts: Buffer[] = [];

  // Message header: 47 01 81 67 00 00 00 01 00 01
  parts.push(Buffer.from([0x47, 0x01, 0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));

  // Type name with length prefix
  const typeName = 'Sooloos.Msg.DistributedBroker.ConnectRequest';
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));

  // ClientBrokerId field (0x24 0x84 0x0e = field marker + type)
  parts.push(Buffer.from([0x24, 0x84, 0x0e]));
  parts.push(Buffer.from('ClientBrokerId'));
  parts.push(clientBrokerId);

  // ClientBrokerName field
  const brokerName = 'claude-code';  // Use our own name
  parts.push(Buffer.from([0x22, 0x81, 0x10]));
  parts.push(Buffer.from('ClientBrokerName'));
  // String value with length prefixes
  parts.push(Buffer.from([0x00, 0x00, 0x00, brokerName.length]));
  parts.push(Buffer.from(brokerName));

  // ProtocolVersion field
  const version = '28';
  parts.push(Buffer.from([0x1b, 0x81, 0x0f]));
  parts.push(Buffer.from('ProtocolVersion'));
  parts.push(Buffer.from([0x00, 0x00, 0x00, version.length]));
  parts.push(Buffer.from(version));

  // ProtocolHash field - use empty/different hash to force schema send
  parts.push(Buffer.from([0x3e, 0x81, 0x0c]));
  parts.push(Buffer.from('ProtocolHash'));
  parts.push(Buffer.from([0x00, 0x00, 0x00, protocolHash.length]));
  parts.push(Buffer.from(protocolHash));

  // ClientBranch field
  const branch = 'production';
  parts.push(Buffer.from([0x20, 0x81, 0x0c]));
  parts.push(Buffer.from('ClientBranch'));
  parts.push(Buffer.from([0x00, 0x00, 0x00, branch.length]));
  parts.push(Buffer.from(branch));

  // End markers
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  return Buffer.concat(parts);
}

function buildClientHello(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

async function debug(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let step = 0;
    let totalReceived = 0;
    let dataCollectTimer: NodeJS.Timeout | null = null;

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log(`Client Broker ID: ${CLIENT_BROKER_ID.toString('hex')}`);
      console.log('');

      step = 1;
      const hello = buildClientHello();
      console.log(`Step 1 - Sending Client Hello (${hello.length} bytes)`);
      socket.write(hello);
    });

    socket.on('data', (data) => {
      totalReceived += data.length;

      // Reset the collection timer
      if (dataCollectTimer) clearTimeout(dataCollectTimer);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('  Server acknowledged');
          const proto = buildProtocolRequest();
          console.log(`Step 2 - Sending Protocol Request (${proto.length} bytes)`);
          socket.write(proto);
        }
        else if (step === 2 && code === 0x82) {
          const sessionId = data.subarray(6, 22).toString('hex');
          console.log(`  Session established: ${sessionId}`);
          step = 3;

          // Try with empty protocol hash to force schema
          const connectReq = buildConnectRequest(CLIENT_BROKER_ID, '');
          console.log(`Step 3 - Sending ConnectRequest with EMPTY ProtocolHash (${connectReq.length} bytes)`);
          console.log(`  Hex: ${connectReq.toString('hex')}`);
          socket.write(connectReq);
        }
      }
      else if (step === 3) {
        step = 4;
        console.log(`\n  Received first response (${data.length} bytes)`);
        console.log(`  Type: 0x${data[0].toString(16)}`);

        // Extract strings
        const str = data.toString('utf8').replace(/[^\x20-\x7E]/g, ' ').trim();
        console.log(`  Strings: ${str.substring(0, 200)}...`);
      }
      else if (step === 4) {
        process.stdout.write(`\r  Receiving data... ${totalReceived} bytes`);

        // Wait for data to stop flowing, then show summary
        dataCollectTimer = setTimeout(() => {
          console.log(`\n\n  Data stream ended at ${totalReceived} bytes`);
          socket.end();
        }, 2000);
      }
    });

    socket.on('timeout', () => {
      console.log(`\n\nTimeout - received ${totalReceived} bytes total`);
      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      reject(err);
    });

    socket.connect(PORT, HOST);
  });
}

debug().catch(console.error);
