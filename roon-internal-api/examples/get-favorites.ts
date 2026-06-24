/**
 * Attempt to extract favorite/liked albums from Roon
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function getFavorites(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  const allData: Buffer[] = [];

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.on('connect', () => {
      console.log('Connected to Roon Core...\n');
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
        console.log('Session established. Collecting data...\n');
        socket.write(SCHEMA_TRIGGER);
      } else if (step === 4) {
        allData.push(data);
      }
    });

    // Analyze after 8 seconds
    setTimeout(() => {
      console.log('\n' + '='.repeat(50));
      console.log('Analysis');
      console.log('='.repeat(50));

      const combined = Buffer.concat(allData);
      const fullText = combined.toString('utf8');

      console.log(`\nData received: ${combined.length} bytes`);
      console.log(`IsFavorite refs: ${fullText.split('IsFavorite').length - 1}`);
      console.log(`AlbumLite refs: ${fullText.split('AlbumLite').length - 1}`);
      console.log(`Image URLs: ${fullText.split('broker:///image/').length - 1}`);

      // Extract readable strings
      const readable: string[] = [];
      let current = '';
      for (let i = 0; i < fullText.length; i++) {
        const code = fullText.charCodeAt(i);
        if (code >= 32 && code < 127) {
          current += fullText[i];
        } else {
          if (current.length >= 8) readable.push(current);
          current = '';
        }
      }

      const filtered = readable
        .filter(s => s.length >= 8 && s.length <= 100)
        .filter(s => !s.includes('Sooloos') && !s.includes('::') && !s.includes('System.'))
        .filter(s => !s.includes('ROON_IMAGE') && !s.includes('broker:'))
        .filter(s => !s.includes('bool ') && !s.includes('string ') && !s.includes('int '))
        .filter(s => !s.includes('Base.') && !s.includes('Generic.') && !s.includes('Collections.'));

      const unique = [...new Set(filtered)].slice(0, 60);

      console.log(`\nReadable content (${unique.length} strings):`);
      unique.forEach(s => console.log(`  ${s}`));

      socket.end();
    }, 8000);

    socket.on('close', () => {
      console.log('\nDone');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

console.log('Extracting data from Roon...\n');
getFavorites().catch(console.error);
