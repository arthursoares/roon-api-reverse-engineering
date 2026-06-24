/**
 * Try query using captured auth credentials
 *
 * From HAR capture:
 * - Auth Token: REDACTED-AUTH-TOKEN
 * - Client Broker ID: 869e1fa3-a69d-412b-9b30-03e3a7813132
 */

import * as net from 'net';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

// Captured credentials
const AUTH_TOKEN = 'REDACTED-AUTH-TOKEN';
const CLIENT_BROKER_UUID = '869e1fa3-a69d-412b-9b30-03e3a7813132';

// Convert UUID to binary format (byte-swap first 3 sections like server broker ID)
function uuidToBuffer(uuid: string): Buffer {
  const parts = uuid.split('-');
  const swapped =
    parts[0].match(/../g)!.reverse().join('') +
    parts[1].match(/../g)!.reverse().join('') +
    parts[2].match(/../g)!.reverse().join('') +
    parts[3] + parts[4];
  return Buffer.from(swapped, 'hex');
}

const CLIENT_BROKER_ID = uuidToBuffer(CLIENT_BROKER_UUID);

// Profile GUID
const PROFILE_SOOID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Use the known working template
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function queryWithToken(): Promise<void> {
  const allData: Buffer[] = [];
  let queryResponseData = Buffer.alloc(0);

  console.log('Using captured credentials:');
  console.log('  Auth Token:', AUTH_TOKEN);
  console.log('  Client Broker ID:', CLIENT_BROKER_ID.toString('hex'));
  console.log('');

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 2;

    socket.on('connect', () => {
      console.log('Connected to Roon Core\n');
      step = 1;
      // Use the captured client broker ID
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]));
    });

    socket.on('data', (data) => {
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        console.log(`Handshake step ${step}: received 0x${code.toString(16)}`);

        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        } else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Session ID received, sending ConnectRequest...');
          socket.write(Buffer.from(CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex')), 'hex'));
        }
      } else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('ConnectRequest accepted! Sending schema trigger...\n');
        socket.write(SCHEMA_TRIGGER);

        // After schema, try a query
        setTimeout(() => {
          step = 5;
          sendFavoriteQuery();
        }, 3000);
      } else if (step === 4) {
        allData.push(data);
      } else if (step === 5) {
        queryResponseData = Buffer.concat([queryResponseData, data]);

        // Check for meaningful response
        const text = data.toString('utf8');
        if (text.includes('AlbumLite') || text.includes('albumTitle')) {
          console.log('*** Album data in response! ***');
        }
      }
    });

    function sendFavoriteQuery() {
      console.log('Sending VirtualAlbumQuery for favorites...');
      msgId++;

      const methodName = 'Sooloos.Broker.Api.Library::VirtualAlbumQuery';
      const methodNameBuf = Buffer.from(methodName);

      const query = Buffer.concat([
        Buffer.from([0x47, msgId & 0xff]),
        Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
        Buffer.from([methodNameBuf.length]),
        methodNameBuf,
        Buffer.from([0x24, 0x84, 0x10]),
        PROFILE_SOOID,
        Buffer.from([0x05, 0x03, 0x05, 0x03])
      ]);

      socket.write(query);
    }

    // Analyze after 10 seconds
    setTimeout(() => {
      console.log('\n' + '='.repeat(50));
      console.log('Results');
      console.log('='.repeat(50));

      console.log(`\nSchema data: ${Buffer.concat(allData).length} bytes`);
      console.log(`Query response: ${queryResponseData.length} bytes`);

      if (queryResponseData.length > 0) {
        const text = queryResponseData.toString('utf8');

        // Look for album content
        const readable: string[] = [];
        let current = '';
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code >= 32 && code < 127) {
            current += text[i];
          } else {
            if (current.length >= 5) readable.push(current);
            current = '';
          }
        }

        const albums = readable
          .filter(s => s.length >= 5 && s.length <= 100)
          .filter(s => !s.includes('Sooloos') && !s.includes('::') && !s.includes('System.'))
          .filter(s => !s.includes('raop') && !s.includes('tcp.local'))
          .filter(s => !s.includes('192.168') && !s.includes('10.147'));

        const unique = [...new Set(albums)].slice(0, 50);

        if (unique.length > 0) {
          console.log('\nContent found:');
          unique.forEach(s => console.log(`  ${s}`));
        }

        if (text.includes('Success')) {
          console.log('\n*** Query may have succeeded! ***');
        }
      }

      socket.end();
    }, 10000);

    socket.on('error', (err) => {
      console.error('Error:', err.message);
      if (err.message.includes('ECONNRESET')) {
        console.log('\nConnection reset - broker ID might still be in use or invalid');
      }
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.connect(PORT, HOST);
  });
}

console.log('='.repeat(50));
console.log('Query with Captured Auth Token');
console.log('='.repeat(50));
console.log('');

queryWithToken().catch(console.error);
