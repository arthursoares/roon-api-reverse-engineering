/**
 * Collect schema data from Roon server
 * Runs for 8 seconds then saves all received data
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// The 0x42 message that triggers schema
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function collect(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    const allData: Buffer[] = [];

    console.log('Connecting...');

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
      allData.push(Buffer.from(data));

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          ));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Connected! Sending schema trigger...');
        socket.write(SCHEMA_TRIGGER);

        // Collect for 8 seconds then stop
        setTimeout(() => {
          console.log('Stopping data collection...');
          socket.end();
        }, 8000);
      }
    });

    socket.on('close', () => {
      const combined = Buffer.concat(allData);
      console.log(`Total received: ${combined.length} bytes`);

      // Save raw data
      fs.writeFileSync('/tmp/roon-schema.bin', combined);
      console.log('Saved binary to /tmp/roon-schema.bin');

      // Extract and save strings
      const strings = combined.toString('utf8')
        .split(/[\x00-\x1f]/)
        .filter(s => s.length > 4);
      fs.writeFileSync('/tmp/roon-schema-strings.txt', strings.join('\n'));
      console.log('Saved strings to /tmp/roon-schema-strings.txt');

      // Extract Sooloos types
      const types = combined.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g);
      if (types) {
        const unique = [...new Set(types)].sort();
        fs.writeFileSync('/tmp/roon-types.txt', unique.join('\n'));
        console.log(`Found ${unique.length} unique Sooloos types`);
        console.log('Saved to /tmp/roon-types.txt');
      }

      resolve();
    });

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      resolve();
    });

    socket.connect(PORT, HOST);
  });
}

collect().catch(console.error);
