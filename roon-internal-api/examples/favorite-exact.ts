/**
 * Send exact bytes from capture to test favorite
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

// Exact ConnectRequest from capture (with placeholder for client ID)
const CONNECT_REQUEST = Buffer.from(
  '4701816d0000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964' +
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' + // Will be replaced
  '288110436c69656e7442726f6b65724e616d650000000e536c6172746962617274666173741b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503',
  'hex'
);

// Exact schema trigger from capture
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Exact FavoriteOrBan registration from capture
const FAV_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Exact favorite command from capture (frame 1866 - favorite action)
const FAV_COMMAND = Buffer.from('43031b2d8454123f01162027273a55d64bbf4a85f335410e2f868ef24701', 'hex');

async function test(): Promise<void> {
  // Use fresh random client ID
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let responseBuffer = Buffer.alloc(0);

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log('Connected');
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
      responseBuffer = Buffer.concat([responseBuffer, data]);

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];

        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          console.log('Session established');
          // Build ConnectRequest with exact client ID
          const req = Buffer.from(CONNECT_REQUEST.toString('hex').replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')), 'hex');
          socket.write(req);
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Sending schema trigger...');
        socket.write(SCHEMA_TRIGGER);

        setTimeout(() => {
          console.log('Sending method registration...');
          socket.write(FAV_REGISTRATION);

          setTimeout(() => {
            step = 5;
            responseBuffer = Buffer.alloc(0);
            console.log('Sending favorite command...');
            console.log(`  Command: ${FAV_COMMAND.toString('hex')}`);
            socket.write(FAV_COMMAND);
          }, 1000);
        }, 4000);
      }
      else if (step === 5) {
        // Look for any response patterns
        const hex = data.toString('hex');
        console.log(`Response chunk: ${hex.substring(0, 60)}...`);

        // Look for c003 (response to msg ID 03)
        if (hex.includes('c003')) {
          const idx = hex.indexOf('c003');
          console.log(`Found c003 at ${idx}: ${hex.substring(idx, idx + 40)}`);
        }

        // Check for Success
        if (responseBuffer.toString('utf8').includes('Success')) {
          console.log('SUCCESS found in response!');
          socket.end();
        }

        // Check for error
        if (responseBuffer.toString('utf8').includes('MissingMethod')) {
          console.log('ERROR: MissingMethod');
          socket.end();
        }
      }
    });

    socket.on('timeout', () => {
      console.log('Timeout - checking buffer for Success...');
      if (responseBuffer.toString('utf8').includes('Success')) {
        console.log('SUCCESS found!');
      } else {
        console.log('No Success found');
        console.log('Last 200 bytes:', responseBuffer.subarray(-200).toString('hex'));
      }
      socket.end();
    });

    socket.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
