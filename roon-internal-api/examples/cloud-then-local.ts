/**
 * Try: Call cloud API first, then connect locally
 *
 * The theory is that the cloud API call "activates" the broker ID
 * and then local queries will work.
 */

import * as net from 'net';
import * as https from 'https';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const AUTH_TOKEN = 'REDACTED-AUTH-TOKEN';
const CLIENT_BROKER_UUID = '869e1fa3-a69d-412b-9b30-03e3a7813132';

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
const PROFILE_SOOID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

// Step 1: Call cloud API
async function callCloudAPI(): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      pushid: `broker/${CLIENT_BROKER_UUID}`,
      roon_auth_token: AUTH_TOKEN,
      os: 'Mac OS X 15.5.0',
      platform: 'macosx',
      machineversion: 205801608,
      branch: 'production',
      appmodifier: '',
      appname: 'Roon'
    });

    const options = {
      hostname: 'api.roonlabs.net',
      port: 443,
      path: `/bits/1/q/roon.base.,roon.internet_discovery.,roon.debug.,roon.client.,roon.broker.,roon.sood.?roon_auth_token=${AUTH_TOKEN}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    };

    console.log('Calling cloud API...');
    console.log(`POST ${options.hostname}${options.path.substring(0, 50)}...`);

    const req = https.request(options, (res) => {
      console.log(`Cloud API status: ${res.statusCode}`);
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log(`Response length: ${data.length} bytes`);
        resolve(res.statusCode === 200);
      });
    });

    req.on('error', (e) => {
      console.error('Cloud API error:', e.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

// Step 2: Connect locally and query
async function connectLocal(): Promise<void> {
  let queryResponse = Buffer.alloc(0);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 2;

    socket.on('connect', () => {
      console.log('\nConnected to local Roon Core');
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, CLIENT_BROKER_ID]));
    });

    socket.on('data', (data) => {
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        } else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(Buffer.from(CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', CLIENT_BROKER_ID.toString('hex')), 'hex'));
        }
      } else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Session established');
        socket.write(SCHEMA_TRIGGER);

        setTimeout(() => {
          step = 5;
          console.log('Sending query...');
          sendQuery();
        }, 3000);
      } else if (step >= 5) {
        queryResponse = Buffer.concat([queryResponse, data]);

        const text = data.toString('utf8');
        if (text.includes('albumTitle') || text.includes('AlbumLite')) {
          console.log('*** ALBUM DATA! ***');
        }
      }
    });

    function sendQuery() {
      msgId++;
      const methodName = 'Sooloos.Broker.Api.Library::VirtualAlbumQuery';
      const methodBuf = Buffer.from(methodName);

      const query = Buffer.concat([
        Buffer.from([0x47, msgId & 0xff]),
        Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
        Buffer.from([methodBuf.length]),
        methodBuf,
        Buffer.from([0x24, 0x84, 0x10]),
        PROFILE_SOOID,
        Buffer.from([0x05, 0x03, 0x05, 0x03])
      ]);

      socket.write(query);
    }

    setTimeout(() => {
      console.log('\n--- Results ---');
      console.log('Query response:', queryResponse.length, 'bytes');

      if (queryResponse.length > 100) {
        const text = queryResponse.toString('utf8');
        const readable: string[] = [];
        let cur = '';
        for (const c of text) {
          const code = c.charCodeAt(0);
          if (code >= 32 && code < 127) cur += c;
          else { if (cur.length >= 5) readable.push(cur); cur = ''; }
        }

        const filtered = [...new Set(readable)]
          .filter(s => s.length >= 5 && s.length <= 80)
          .filter(s => !s.includes('Sooloos') && !s.includes('::'))
          .filter(s => !s.includes('192.168') && !s.includes('raop'))
          .slice(0, 30);

        console.log('\nContent:');
        filtered.forEach(s => console.log(' ', s));
      }

      socket.end();
    }, 8000);

    socket.on('error', (err) => console.error('Error:', err.message));
    socket.on('close', () => { console.log('\nDone'); resolve(); });
    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('='.repeat(50));
  console.log('Cloud API First, Then Local');
  console.log('='.repeat(50));
  console.log('');

  const cloudOK = await callCloudAPI();

  if (cloudOK) {
    console.log('\nCloud API succeeded, now connecting locally...');
    await connectLocal();
  } else {
    console.log('\nCloud API failed');
  }
}

main().catch(console.error);
