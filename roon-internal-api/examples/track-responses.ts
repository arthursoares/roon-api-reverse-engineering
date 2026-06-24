/**
 * Track ALL responses after sending the favorite command
 * Watch for any response pattern, not just the expected one
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// From capture
const FAV_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Use the EXACT favorite command bytes from the capture
const FAV_COMMAND = Buffer.from('43031b2d8454123f01162027273a55d64bbf4a85f335410e2f868ef24701', 'hex');

async function trackResponses(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client ID: ${clientBrokerId.toString('hex')}`);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let commandSentTime = 0;
    let postCommandData = Buffer.alloc(0);

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

        // Wait for schema, then send registration and command in sequence
        setTimeout(() => {
          console.log('Sending method registration (0x06)...');
          socket.write(FAV_REGISTRATION);

          setTimeout(() => {
            console.log('Sending favorite command (0x43)...');
            console.log(`  ${FAV_COMMAND.toString('hex')}`);
            step = 5;
            commandSentTime = Date.now();
            postCommandData = Buffer.alloc(0);
            socket.write(FAV_COMMAND);
          }, 200);
        }, 3500);
      }
      else if (step === 5) {
        postCommandData = Buffer.concat([postCommandData, data]);
        const elapsed = Date.now() - commandSentTime;

        // Log first few post-command messages with timing
        if (postCommandData.length < 10000) {
          console.log(`\n[+${elapsed}ms] Message type 0x${data[0].toString(16)}, ${data.length} bytes`);

          // Check for response patterns
          const hex = data.toString('hex');

          // Look for c003 (response to msg 03 from capture)
          if (hex.includes('c003')) {
            const idx = hex.indexOf('c003');
            console.log(`  *** FOUND c003 at position ${idx/2}! ***`);
            console.log(`  Context: ${hex.substring(idx, idx + 40)}`);
          }

          // Look for c006 (response to msg 06)
          if (hex.includes('c006')) {
            const idx = hex.indexOf('c006');
            console.log(`  *** FOUND c006 at position ${idx/2}! ***`);
            console.log(`  Context: ${hex.substring(idx, idx + 40)}`);
          }

          // Look for 8003 or 8006 (error responses)
          if (hex.includes('8003') || hex.includes('8006')) {
            console.log(`  *** FOUND potential error response! ***`);
            console.log(`  Hex: ${hex.substring(0, 60)}`);
          }

          // Look for any 0xc0 or 0x80 followed by low number (response pattern)
          for (let i = 0; i < Math.min(data.length - 1, 100); i++) {
            if ((data[i] === 0xc0 || data[i] === 0x80) && data[i + 1] < 0x20) {
              const msgId = data[i + 1];
              console.log(`  Found response pattern at ${i}: 0x${data[i].toString(16)} ${msgId.toString(16)}`);
              console.log(`    Next 20 bytes: ${data.subarray(i, Math.min(i + 20, data.length)).toString('hex')}`);
              const text = data.subarray(i, Math.min(i + 30, data.length)).toString('utf8').replace(/[^\x20-\x7E]/g, '.');
              console.log(`    As text: ${text}`);
            }
          }
        }
      }
    });

    socket.on('timeout', () => {
      console.log(`\nTimeout. Total post-command data: ${postCommandData.length} bytes`);

      // Final search for any response in collected data
      console.log('\nFinal search for responses:');
      for (let i = 0; i < postCommandData.length - 1; i++) {
        if ((postCommandData[i] === 0xc0 || postCommandData[i] === 0x80) &&
            postCommandData[i + 1] >= 0x03 && postCommandData[i + 1] <= 0x10) {
          const context = postCommandData.subarray(i, Math.min(i + 30, postCommandData.length));
          const text = context.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
          if (text.includes('Success') || text.includes('Error') || text.includes('Missing')) {
            console.log(`  At ${i}: ${context.toString('hex')}`);
            console.log(`  Text: ${text}`);
          }
        }
      }

      socket.end();
    });

    socket.on('close', () => {
      console.log('\nDone');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

trackResponses().catch(console.error);
