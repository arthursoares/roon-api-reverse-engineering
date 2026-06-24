/**
 * Debug handshake - capture and display all data received
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const CLIENT_BROKER_ID = crypto.randomBytes(16);
const MAGIC = Buffer.from('ROON');

// ConnectRequest template
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

async function debug(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let step = 0;
    let allData: Buffer[] = [];

    socket.setTimeout(10000);

    socket.on('connect', () => {
      console.log(`Connected to ${HOST}:${PORT}`);
      console.log(`Client Broker ID: ${CLIENT_BROKER_ID.toString('hex')}`);
      console.log('');

      step = 1;
      const hello = buildClientHello();
      console.log(`Step 1 - Sending Client Hello (${hello.length} bytes)`);
      console.log(`  ${hello.toString('hex')}`);
      socket.write(hello);
    });

    socket.on('data', (data) => {
      allData.push(data);
      console.log(`\nReceived ${data.length} bytes:`);
      console.log(`  Hex: ${data.toString('hex').substring(0, 100)}${data.length > 50 ? '...' : ''}`);

      // Try to extract readable strings
      const str = data.toString('utf8').replace(/[^\x20-\x7E]/g, ' ').trim();
      if (str.length > 5) {
        console.log(`  Strings: ${str.substring(0, 200)}`);
      }

      // Check for ROON magic
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        console.log(`  ROON response code: 0x${code.toString(16)}`);

        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('\n--- Server acknowledged, sending Protocol Request ---');
          const proto = buildProtocolRequest();
          console.log(`Step 2 - Sending Protocol Request (${proto.length} bytes)`);
          socket.write(proto);
        }
        else if (step === 2 && code === 0x82) {
          const sessionId = data.subarray(6, 22).toString('hex');
          console.log(`  Session ID: ${sessionId}`);
          step = 3;

          console.log('\n--- Session established, sending ConnectRequest ---');
          const connectReq = buildConnectRequest();
          console.log(`Step 3 - Sending ConnectRequest (${connectReq.length} bytes)`);
          console.log(`  First 100 hex: ${connectReq.toString('hex').substring(0, 100)}...`);
          socket.write(connectReq);
        }
      }
      else if (step === 3) {
        console.log(`  Response type byte: 0x${data[0].toString(16)}`);
        step = 4;
        // Don't send anything more, just observe response
      }
    });

    socket.on('timeout', () => {
      console.log('\n=== TIMEOUT ===');
      const total = Buffer.concat(allData);
      console.log(`Total received: ${total.length} bytes`);
      console.log('\nFull response dump:');
      console.log(total.toString('hex'));
      console.log('\nReadable strings:');
      console.log(total.toString('utf8').replace(/[^\x20-\x7E\n]/g, '.'));
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
