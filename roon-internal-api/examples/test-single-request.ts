/**
 * Single clean test - one request only
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(15000);

    socket.on('connect', () => {
      console.log('1. Connected');
      step = 1;
      socket.write(Buffer.concat([
        MAGIC,
        Buffer.from([0x01, 0x04]),
        SERVER_BROKER_ID,
        clientBrokerId
      ]));
    });

    socket.on('data', (data) => {
      console.log(`   Received ${data.length} bytes: ${data.subarray(0, 10).toString('hex')}...`);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          console.log('2. Hello acked');
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('3. Session established');

          const connectReq = Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          );
          socket.write(connectReq);
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('4. ConnectRequest accepted');
        console.log(`   Response type names: ${(data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || []).join(', ')}`);

        // Just do a keepalive after 1 second
        setTimeout(() => {
          console.log('\n5. Sending keepalive...');
          socket.write(Buffer.from([0x41, 0x0a, 0x00]));
        }, 1000);

        // Then try ONE library request after another second
        setTimeout(() => {
          console.log('\n6. Sending VirtualAlbumQueryRequest...');
          const typeName = 'Sooloos.Msg.Library.VirtualAlbumQueryRequest';
          const req = Buffer.concat([
            Buffer.from([0x47, 0x0b]),
            Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
            Buffer.from([typeName.length]),
            Buffer.from(typeName),
            Buffer.from([0x05, 0x03, 0x05, 0x03])
          ]);
          socket.write(req);
        }, 2000);

        // Wait longer for response
        setTimeout(() => {
          console.log('\n7. Waiting for response (10s)...');
        }, 3000);

        // Close after waiting much longer
        setTimeout(() => {
          console.log('\nClosing...');
          socket.end();
        }, 15000);
      }
      else if (step === 4) {
        // Log any response
        const msgId = data[1];
        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        console.log(`   Response msgId=${msgId}: ${types.join(', ') || '(no types)'}`);
        console.log(`   Hex: ${data.toString('hex').substring(0, 60)}`);
      }
    });

    socket.on('timeout', () => {
      console.log('Timeout');
      socket.end();
    });

    socket.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
    });

    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
