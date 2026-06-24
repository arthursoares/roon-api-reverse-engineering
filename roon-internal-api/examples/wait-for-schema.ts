/**
 * Wait longer after ConnectRequest to see if schema arrives asynchronously
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
    let totalBytes = 0;
    let lastReceiveTime = Date.now();
    let checkInterval: NodeJS.Timeout | null = null;

    socket.setTimeout(120000); // 2 minute timeout

    socket.on('connect', () => {
      console.log('Connected');
      console.log(`Client Broker ID: ${clientBrokerId.toString('hex')}\n`);
      step = 1;
      socket.write(buildClientHello(clientBrokerId));
    });

    socket.on('data', (data) => {
      totalBytes += data.length;
      lastReceiveTime = Date.now();

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('Step 1: Hello acked');
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Step 2: Session established');
          socket.write(buildConnectRequest(clientBrokerId));
        }
      }
      else if (step === 3) {
        step = 4;
        console.log('Step 3: ConnectRequest sent, waiting for response...\n');

        // Start periodic status updates
        checkInterval = setInterval(() => {
          const elapsed = Date.now() - lastReceiveTime;
          console.log(`  Total received: ${totalBytes} bytes (${elapsed}ms since last data)`);

          // Send a keepalive every 10 seconds to keep connection active
          socket.write(Buffer.from([0x41, 0x00, 0x00]));
        }, 5000);
      }

      if (step === 4) {
        // Log each chunk of data
        const typeNames = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        if (typeNames.length > 0) {
          console.log(`  +${data.length} bytes: ${typeNames.slice(0, 3).join(', ')}`);
        } else if (data[0] === 0xc0) {
          // Keepalive response, ignore
        } else {
          console.log(`  +${data.length} bytes (type: 0x${data[0].toString(16)})`);
        }
      }
    });

    // After 30 seconds, try sending favorite
    setTimeout(() => {
      if (step >= 4) {
        console.log('\n=== After 30s, trying favorite command ===\n');
        console.log(`Total received so far: ${totalBytes} bytes`);

        const favPacket = Buffer.from('43011b328454123f01162027273a55d64bbf4a85f335410e2f83faa41101', 'hex');
        console.log('Sending favorite packet...');
        socket.write(favPacket);

        // Wait 5 more seconds for response
        setTimeout(() => {
          console.log(`\nTotal received: ${totalBytes} bytes`);
          console.log('Closing connection...');
          if (checkInterval) clearInterval(checkInterval);
          socket.end();
        }, 5000);
      }
    }, 30000);

    socket.on('timeout', () => {
      console.log('\nSocket timeout');
      if (checkInterval) clearInterval(checkInterval);
      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      console.log(`Final total: ${totalBytes} bytes`);
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      if (checkInterval) clearInterval(checkInterval);
    });

    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
