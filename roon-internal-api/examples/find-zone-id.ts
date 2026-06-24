/**
 * Find zone IDs from streaming updates
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function findZoneId(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  const zoneData: string[] = [];

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(10000);

    socket.on('connect', () => {
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        } else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(Buffer.from(CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')), 'hex'));
        }
      } else if (step === 3 && data[0] === 0x80) {
        step = 4;
        socket.write(SCHEMA_TRIGGER);
      } else if (step === 4) {
        const hex = data.toString('hex');

        // Look for 85d0da7b (Zone type) followed by Office name
        const zoneTypeMarker = '85d0da7b';
        let pos = 0;
        while ((pos = hex.indexOf(zoneTypeMarker, pos)) !== -1) {
          // Check if Office follows within 50 chars
          const after = hex.substring(pos, pos + 100);
          if (after.includes('4f6666696365')) { // 'Office' in hex
            const before = hex.substring(Math.max(0, pos - 60), pos);
            console.log('=== Zone with Office ===');
            console.log('Before zone type:', before);
            console.log('After zone type:', after.substring(0, 80));
            zoneData.push(before);
          }
          pos += 8;
        }
      }
    });

    socket.on('timeout', () => {
      console.log('\nDone. Found', zoneData.length, 'Office zone references');
      socket.end();
    });

    socket.on('close', () => resolve());
    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

findZoneId().catch(console.error);
