/**
 * Try different callback IDs in the 0x06 registration
 *
 * The `81 13` in the original might be a callback ID.
 * Let's try different values to see if any work.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Method signature (after the callback ID and type markers)
const METHOD_SIG = Buffer.from(
  '810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Command bytes (after header)
const CMD_BYTES = Buffer.from('1b2d8454123f01162027273a55d64bbf4a85f335410e2f868ef24701', 'hex');

function buildRegistration(callbackId: number): Buffer {
  // 06 [callbackId as varint] 84 54 [method sig]
  let idBytes: Buffer;
  if (callbackId < 128) {
    idBytes = Buffer.from([callbackId]);
  } else {
    idBytes = Buffer.from([0x80 | (callbackId & 0x7f), (callbackId >> 7) & 0x7f]);
  }
  return Buffer.concat([
    Buffer.from([0x06]),
    idBytes,
    Buffer.from([0x84, 0x54]),
    METHOD_SIG
  ]);
}

function buildCommand(msgId: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x43, msgId]),
    CMD_BYTES
  ]);
}

async function tryCallbackIds(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`Client ID: ${clientBrokerId.toString('hex')}`);

  // Different callback IDs to try
  const callbackIds = [
    0x01,  // Simple 1
    0x13,  // Original (19)
    0x00,  // Zero
    0x02,  // 2
    0x0a,  // 10
  ];

  let currentIdx = 0;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let responseBuffer = Buffer.alloc(0);

    socket.setTimeout(40000);

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
      if (step >= 5) {
        responseBuffer = Buffer.concat([responseBuffer, data]);
      }

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

        setTimeout(() => tryNext(), 3000);
      }
      else if (step === 5) {
        // Check for any response containing Success or callback patterns
        const hex = data.toString('hex');
        const text = data.toString('utf8');

        if (text.includes('Success')) {
          console.log('*** FOUND SUCCESS! ***');
          const idx = text.indexOf('Success');
          console.log(`Context: ${hex.substring(Math.max(0, idx * 2 - 20), idx * 2 + 30)}`);
        }

        // Look for c0 XX patterns (callback responses)
        for (let i = 0; i < data.length - 1; i++) {
          if (data[i] === 0xc0 && data[i + 1] < 0x20) {
            console.log(`  Callback response at ${i}: ${data.subarray(i, Math.min(i + 20, data.length)).toString('hex')}`);
          }
        }
      }
    });

    function tryNext() {
      if (currentIdx >= callbackIds.length) {
        console.log('\nAll callback IDs tried.');
        // Final check of accumulated data
        checkForSuccess(responseBuffer);
        setTimeout(() => socket.end(), 2000);
        return;
      }

      const callbackId = callbackIds[currentIdx];
      console.log(`\nTrying callback ID: 0x${callbackId.toString(16)} (${callbackId})`);

      const reg = buildRegistration(callbackId);
      const cmd = buildCommand(currentIdx + 1);

      console.log(`  Registration: ${reg.subarray(0, 20).toString('hex')}...`);
      console.log(`  Command: ${cmd.toString('hex')}`);

      step = 5;
      responseBuffer = Buffer.alloc(0);
      socket.write(reg);

      setTimeout(() => {
        socket.write(cmd);
        currentIdx++;
        setTimeout(tryNext, 2000);
      }, 200);
    }

    function checkForSuccess(buf: Buffer) {
      const text = buf.toString('utf8');
      if (text.includes('Success')) {
        console.log('\n*** SUCCESS FOUND IN BUFFER! ***');
        const idx = text.indexOf('Success');
        console.log(`At position ${idx}: ${buf.subarray(Math.max(0, idx - 10), idx + 20).toString('hex')}`);
      } else if (text.includes('Error') || text.includes('Missing')) {
        console.log('\nError pattern found');
      }
    }

    socket.on('timeout', () => {
      console.log('\nTimeout');
      checkForSuccess(responseBuffer);
      socket.end();
    });

    socket.on('close', () => {
      console.log('Done');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

tryCallbackIds().catch(console.error);
