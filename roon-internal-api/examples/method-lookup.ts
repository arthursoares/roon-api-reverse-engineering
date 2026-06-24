/**
 * Test method lookup/registration and watch for response
 *
 * The 0x06 message might be a request for method index,
 * with the server responding with the assigned index.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// FavoriteOrBan method registration (0x06 message)
const FAV_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Decode the registration to understand it
console.log('Method registration bytes:');
console.log(`  Type: 0x06`);
console.log(`  Bytes after type: ${FAV_REGISTRATION.subarray(1, 10).toString('hex')}`);
console.log(`  String: ${FAV_REGISTRATION.subarray(6).toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);
console.log('');

async function testMethodLookup(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let messageBuffer = Buffer.alloc(0);
    let registrationSent = false;

    socket.setTimeout(20000);

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
      messageBuffer = Buffer.concat([messageBuffer, data]);

      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
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
        console.log('Connected. Triggering schema...');
        socket.write(SCHEMA_TRIGGER);

        // Send method registration after schema starts arriving
        setTimeout(() => {
          console.log('');
          console.log('Sending method registration (0x06)...');
          console.log(`  Bytes: ${FAV_REGISTRATION.toString('hex')}`);
          messageBuffer = Buffer.alloc(0);  // Clear buffer
          registrationSent = true;
          socket.write(FAV_REGISTRATION);
        }, 3000);
      }
      else if (registrationSent) {
        // Look for responses starting with 0x86 or 0xc6 (response to 0x06)
        // Or any response containing method index info
        const msgType = data[0];

        // Check various response patterns
        if (msgType === 0x86 || msgType === 0xc6 || msgType === 0x06) {
          console.log(`\n*** Found potential response: type=0x${msgType.toString(16)} ***`);
          console.log(`  Hex: ${data.subarray(0, Math.min(50, data.length)).toString('hex')}`);
        }

        // Look for "1b 2d" pattern (the method index from capture)
        const hex = data.toString('hex');
        if (hex.includes('1b2d')) {
          const idx = hex.indexOf('1b2d');
          console.log(`\n*** Found 1b2d at position ${idx/2}: ${hex.substring(Math.max(0, idx-20), idx+20)} ***`);
        }

        // Look for any message type 0x80-0xff (potential responses)
        if (msgType >= 0x80) {
          console.log(`Response type 0x${msgType.toString(16)}, length ${data.length}`);
          if (data.length < 100) {
            console.log(`  Full: ${data.toString('hex')}`);
          }
        }
      }
    });

    socket.on('timeout', () => {
      console.log('\nTimeout. Analyzing buffer...');

      // Look for 0x86 or response patterns in buffer
      for (let i = 0; i < messageBuffer.length - 2; i++) {
        if (messageBuffer[i] === 0x86 || messageBuffer[i] === 0xc6) {
          console.log(`Found 0x${messageBuffer[i].toString(16)} at offset ${i}:`);
          console.log(`  ${messageBuffer.subarray(i, Math.min(i + 30, messageBuffer.length)).toString('hex')}`);
        }
      }

      socket.end();
    });

    socket.on('close', () => {
      console.log('\nConnection closed');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

testMethodLookup().catch(console.error);
