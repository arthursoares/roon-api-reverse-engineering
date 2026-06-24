/**
 * Try including auth token in ConnectRequest
 */

import * as net from 'net';

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

// Build ConnectRequest with potential auth token field
function buildConnectRequestWithAuth(): Buffer {
  const typeName = 'Sooloos.Msg.DistributedBroker.ConnectRequest';

  // Encode string field: length prefix + string bytes
  function encodeString(s: string): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(s.length);
    return Buffer.concat([len, Buffer.from(s)]);
  }

  // Build fields based on captured format
  // Original: 470181670000000100012c[typename]24840e[ClientBrokerId][16bytes]228110[ClientBrokerName]...

  const fields: Buffer[] = [];

  // ClientBrokerId field
  fields.push(Buffer.from([0x84, 0x0e]));  // Type marker
  fields.push(Buffer.from('ClientBrokerId'));
  fields.push(CLIENT_BROKER_ID);

  // ClientBrokerName field
  fields.push(Buffer.from([0x22, 0x81, 0x10]));
  fields.push(Buffer.from('ClientBrokerName'));
  fields.push(encodeString('HQ-00452'));

  // ProtocolVersion field
  fields.push(Buffer.from([0x1b, 0x81, 0x0f]));
  fields.push(Buffer.from('ProtocolVersion'));
  fields.push(encodeString('28'));

  // ProtocolHash field
  fields.push(Buffer.from([0x3e, 0x81, 0x0c]));
  fields.push(Buffer.from('ProtocolHash'));
  fields.push(encodeString('aaedd22e2e6e452231e74dd309ffb9d27a9751ed'));

  // ClientBranch field
  fields.push(Buffer.from([0x20, 0x81, 0x0c]));
  fields.push(Buffer.from('ClientBranch'));
  fields.push(encodeString('production'));

  // TRY: Add AuthToken field (experimental - might not be valid)
  // fields.push(Buffer.from([0x20, 0x81, 0x09]));
  // fields.push(Buffer.from('AuthToken'));
  // fields.push(encodeString(AUTH_TOKEN));

  // Trailer
  fields.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));

  // Assemble message
  const fieldData = Buffer.concat(fields);
  const header = Buffer.concat([
    Buffer.from([0x47, 0x01]),
    Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
    Buffer.from([typeName.length]),
    Buffer.from(typeName),
    Buffer.from([0x24])  // Fields marker
  ]);

  return Buffer.concat([header, fieldData]);
}

async function queryWithAuth(): Promise<void> {
  let queryResponse = Buffer.alloc(0);

  console.log('Auth Token:', AUTH_TOKEN);
  console.log('Client Broker:', CLIENT_BROKER_ID.toString('hex'));
  console.log('');

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 2;

    socket.on('connect', () => {
      console.log('Connected\n');
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
          console.log('Sending ConnectRequest...');
          // Use the custom built request
          const connectReq = buildConnectRequestWithAuth();
          console.log('ConnectRequest hex:', connectReq.toString('hex').substring(0, 100) + '...');
          socket.write(connectReq);
        }
      } else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('ConnectRequest accepted!');
        console.log('Sending schema trigger...\n');
        socket.write(SCHEMA_TRIGGER);

        setTimeout(() => {
          step = 5;
          console.log('Sending query...');
          sendQuery();
        }, 3000);
      } else if (step >= 5) {
        queryResponse = Buffer.concat([queryResponse, data]);

        // Look for album data
        const text = data.toString('utf8');
        if (text.includes('albumTitle') || text.includes('artistName')) {
          console.log('*** ALBUM DATA FOUND! ***');
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

      if (queryResponse.length > 0) {
        const text = queryResponse.toString('utf8');
        // Extract readable
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
    }, 10000);

    socket.on('error', (err) => console.error('Error:', err.message));
    socket.on('close', () => { console.log('\nDone'); resolve(); });
    socket.connect(PORT, HOST);
  });
}

queryWithAuth().catch(console.error);
