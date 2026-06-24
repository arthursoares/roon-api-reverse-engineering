/**
 * Try to query favorite albums using Library::VirtualAlbumQuery
 *
 * AlbumQueryCriteria has:
 * - RequireIsFavorite: bool
 * - ExcludeIsFavorite: bool
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Profile GUID from captured session
const PROFILE_SOOID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

async function queryFavorites(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  const allData: Buffer[] = [];
  let queryResponseData = Buffer.alloc(0);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 2;

    socket.on('connect', () => {
      console.log('Connected to Roon Core\n');
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
        console.log('Session established. Sending schema trigger...\n');
        socket.write(SCHEMA_TRIGGER);

        // After schema loads, send query
        setTimeout(() => {
          step = 5;
          sendQuery();
        }, 4000);
      } else if (step === 4) {
        allData.push(data);
      } else if (step === 5) {
        queryResponseData = Buffer.concat([queryResponseData, data]);
        // Check for response
        const text = data.toString('utf8');
        if (text.includes('Success') || text.includes('Error') || text.includes('Missing')) {
          console.log('Response received');
        }
      }
    });

    function sendQuery() {
      console.log('Sending VirtualAlbumQuery for favorites...\n');
      msgId++;

      // Try the named method approach
      // Library::VirtualAlbumQuery(Sooid profile, AlbumQueryCriteria criteria, VirtualQueryParameters params, callback)
      const methodName = 'Sooloos.Broker.Api.Library::VirtualAlbumQuery';
      const methodNameBuf = Buffer.from(methodName);

      // Build a simple query message
      // This is experimental - we need to figure out the exact parameter encoding
      const query = Buffer.concat([
        Buffer.from([0x47, msgId & 0xff]),  // Message type + ID
        Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),  // Standard header
        Buffer.from([methodNameBuf.length]),  // Method name length
        methodNameBuf,
        Buffer.from([0x24]),  // Parameters marker
        // Parameter 1: Profile Sooid (19 bytes with type marker)
        Buffer.from([0x84, 0x10]),  // Type marker
        PROFILE_SOOID,
        // Try to indicate RequireIsFavorite = true
        // This is guesswork based on the schema
        Buffer.from([0x05, 0x03, 0x05, 0x03])  // Trailer
      ]);

      console.log('Query hex:', query.toString('hex'));
      socket.write(query);

      // Also try a simpler approach - just request the method registration
      setTimeout(() => {
        msgId++;
        // Try registering a callback for favorites
        const registerMsg = Buffer.concat([
          Buffer.from([0x06, msgId & 0xff]),
          Buffer.from([0x84, 0x54]),  // Type marker
          Buffer.from([methodName.length]),
          methodNameBuf,
          Buffer.from([0x05, 0x03])
        ]);
        console.log('\nRegistering method...');
        socket.write(registerMsg);
      }, 2000);
    }

    // Analyze after 12 seconds
    setTimeout(() => {
      console.log('\n' + '='.repeat(50));
      console.log('Query Response Analysis');
      console.log('='.repeat(50));

      console.log(`\nQuery response size: ${queryResponseData.length} bytes`);

      if (queryResponseData.length > 0) {
        const text = queryResponseData.toString('utf8');

        // Look for album names in response
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

        const filtered = readable
          .filter(s => s.length >= 5 && s.length <= 100)
          .filter(s => !s.includes('Sooloos') && !s.includes('::'))
          .slice(0, 40);

        if (filtered.length > 0) {
          console.log('\nContent in response:');
          filtered.forEach(s => console.log(`  ${s}`));
        }

        // Check for error/success
        if (text.includes('Missing')) {
          console.log('\n*** Method not found or missing parameters ***');
        }
        if (text.includes('Success')) {
          console.log('\n*** Query succeeded! ***');
        }
      } else {
        console.log('\nNo response received - query may require authorization');
      }

      socket.end();
    }, 12000);

    socket.on('close', () => {
      console.log('\nDone');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

console.log('Querying Roon for favorite albums...\n');
queryFavorites().catch(console.error);
