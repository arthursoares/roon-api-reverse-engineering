/**
 * Enumerate different opcodes to see which ones get responses
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildClientHello(clientBrokerId: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]);
}

function buildProtocolRequest(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]);
}

function buildConnectRequest(clientBrokerId: Buffer): Buffer {
  const hex = CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex'));
  return Buffer.from(hex, 'hex');
}

async function testOpcodes(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let currentOpcode = 0;
    let msgId = 1;
    const results: { opcode: number; response: string }[] = [];

    socket.setTimeout(60000);

    socket.on('connect', () => {
      console.log('Connected. Setting up session...\n');
      step = 1;
      socket.write(buildClientHello(clientBrokerId));
    });

    socket.on('data', (data) => {
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(buildProtocolRequest());
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(buildConnectRequest(clientBrokerId));
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Session ready. Enumerating opcodes...\n');

        // Start testing opcodes
        testNextOpcode();
      }
      else if (step === 4) {
        // Got a response!
        const respStr = data.toString('hex');
        results.push({ opcode: currentOpcode, response: respStr });
        console.log(`  Opcode 0x${currentOpcode.toString(16).padStart(2, '0')}: ${data.length} bytes - ${respStr.substring(0, 40)}${respStr.length > 40 ? '...' : ''}`);
        currentOpcode++;
        if (currentOpcode <= 0x30) {
          setTimeout(testNextOpcode, 100);
        } else {
          finishTest();
        }
      }
    });

    function testNextOpcode(): void {
      // Skip certain opcodes we already know
      while (currentOpcode === 0x00) {
        currentOpcode++;
      }

      if (currentOpcode > 0x30) {
        finishTest();
        return;
      }

      msgId = (msgId + 1) & 0xff;

      // Send minimal packet: type 0x43, msgId, opcode, 0x00 (empty payload marker)
      const packet = Buffer.from([0x43, msgId, currentOpcode, 0x00]);
      socket.write(packet);

      // If no response in 500ms, move to next
      setTimeout(() => {
        if (step === 4) {
          console.log(`  Opcode 0x${currentOpcode.toString(16).padStart(2, '0')}: no response (timeout)`);
          currentOpcode++;
          if (currentOpcode <= 0x30) {
            testNextOpcode();
          } else {
            finishTest();
          }
        }
      }, 500);
    }

    function finishTest(): void {
      step = 5;
      console.log('\n=== Summary ===');
      console.log(`Opcodes with responses: ${results.length}`);
      for (const r of results) {
        console.log(`  0x${r.opcode.toString(16).padStart(2, '0')}: ${r.response.substring(0, 60)}...`);
      }
      socket.end();
    }

    socket.on('timeout', () => {
      console.log('Global timeout');
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

testOpcodes().catch(console.error);
