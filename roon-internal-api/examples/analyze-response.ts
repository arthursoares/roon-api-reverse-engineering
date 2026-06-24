/**
 * Analyze ConnectResponse to find profile IDs
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

async function analyze(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(10000);

    socket.on('connect', () => {
      step = 1;
      socket.write(Buffer.concat([
        MAGIC,
        Buffer.from([0x01, 0x04]),
        SERVER_BROKER_ID,
        clientBrokerId
      ]));
    });

    socket.on('data', (data) => {
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          console.log('Session ID:', data.subarray(6, 22).toString('hex'));
          step = 3;
          socket.write(Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          ));
        }
      }
      else if (step === 3) {
        console.log('\nConnectResponse received:');
        console.log(`Length: ${data.length} bytes`);
        console.log('\nHex dump:');

        // Print hex dump
        for (let i = 0; i < Math.min(data.length, 500); i += 16) {
          const hex = data.subarray(i, Math.min(i + 16, data.length)).toString('hex').match(/.{2}/g)?.join(' ') || '';
          const ascii = data.subarray(i, Math.min(i + 16, data.length)).toString('utf8').replace(/[^\x20-\x7E]/g, '.');
          console.log(`${i.toString(16).padStart(4, '0')}: ${hex.padEnd(48)} ${ascii}`);
        }

        // Save full response
        fs.writeFileSync('/tmp/connect-response.bin', data);
        console.log('\nSaved full response to /tmp/connect-response.bin');

        // Find all 16-byte sequences that look like GUIDs
        console.log('\nLooking for possible GUIDs (16-byte sequences)...');
        for (let i = 0; i < data.length - 16; i++) {
          // Look for GUID-like patterns (usually follow certain bytes)
          const prevByte = i > 0 ? data[i-1] : 0;
          if (prevByte === 0x10 || prevByte === 0x84 || prevByte === 0x8e) {
            const guid = data.subarray(i, i + 16);
            console.log(`  Offset ${i.toString(16)}: ${guid.toString('hex')}`);
          }
        }

        socket.end();
      }
    });

    socket.on('timeout', () => {
      console.log('Timeout');
      socket.end();
    });

    socket.on('close', () => {
      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      resolve();
    });

    socket.connect(PORT, HOST);
  });
}

analyze().catch(console.error);
