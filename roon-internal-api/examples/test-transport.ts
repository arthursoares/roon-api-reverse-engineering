/**
 * Test transport commands (play/pause/skip) to see if they require auth
 *
 * This tests whether transport control requires the same authorization
 * that mutation commands (like favorites) seem to need.
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');
const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// Zone sooid for "Office" zone (extracted from capture)
const OFFICE_ZONE_SOOID = Buffer.from('YOUR_ZONE_SOOID', 'hex');

async function testTransport(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  let responseReceived = false;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 1;

    socket.setTimeout(15000);

    socket.on('connect', () => {
      console.log('Connected to Roon Core\n');
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
      // Handshake
      if (data.length >= 4 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        } else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(Buffer.from(CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')), 'hex'));
        }
      }
      // ConnectResponse
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Session established. Sending schema trigger...');
        socket.write(SCHEMA_TRIGGER);

        // Wait for schema then send transport command
        setTimeout(() => {
          step = 5;
          console.log('\nSending transport command (Zone::Previous)...');
          sendTransportCommand();
        }, 3000);
      }
      // Response to our command
      else if (step === 5) {
        const hex = data.toString('hex');

        // Look for response to our message ID
        if (hex.startsWith('c0') || data[0] === 0xc0 || data[0] === 0x80) {
          responseReceived = true;
          console.log('\n=== Received Response ===');
          console.log('First bytes:', hex.substring(0, 40));

          // Check for Success or error
          const text = data.toString('utf8');
          if (text.includes('Success')) {
            console.log('*** SUCCESS! Transport command worked! ***');
          } else if (text.includes('Missing') || text.includes('Error')) {
            console.log('Error in response:', text.replace(/[^\x20-\x7E]/g, '.').substring(0, 100));
          }
        }
      }
    });

    function sendTransportCommand() {
      // Try different transport command patterns

      // Pattern 1: Named method call for Zone::Pause
      // Format: 47 [msgId] [method-name-header] [method-name] [params]
      const methodName = 'Sooloos.Broker.Api.Zone::Pause';
      const methodNameBuf = Buffer.from(methodName);

      // Build a 0x47 named method call
      msgId++;
      const cmd1 = Buffer.concat([
        Buffer.from([0x47, msgId & 0xff]),
        Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),  // Header
        Buffer.from([methodNameBuf.length]),  // Method name length
        methodNameBuf,
        Buffer.from([0x24]),  // Parameters marker
        Buffer.from([0x84, 0x04]),  // Zone type marker
        OFFICE_ZONE_SOOID,  // Zone ID
        Buffer.from([0x05, 0x03, 0x05, 0x03])  // Trailer
      ]);

      console.log('Sending Pause command...');
      console.log('Command hex:', cmd1.toString('hex'));
      socket.write(cmd1);

      // Also try a simpler indexed call pattern after a delay
      setTimeout(() => {
        // Pattern 2: Try Zone::Previous (documented in ROON_INTERNAL_API.md)
        msgId++;
        const methodName2 = 'Sooloos.Broker.Api.Zone::Previous';
        const methodNameBuf2 = Buffer.from(methodName2);

        const cmd2 = Buffer.concat([
          Buffer.from([0x47, msgId & 0xff]),
          Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
          Buffer.from([methodNameBuf2.length]),
          methodNameBuf2,
          Buffer.from([0x24, 0x84, 0x04]),
          OFFICE_ZONE_SOOID,
          Buffer.from([0x05, 0x03, 0x05, 0x03])
        ]);

        console.log('\nSending Previous command...');
        socket.write(cmd2);
      }, 2000);
    }

    socket.on('timeout', () => {
      console.log('\n=== Timeout ===');
      if (!responseReceived) {
        console.log('No response received - command was likely SILENTLY IGNORED');
        console.log('This suggests transport commands ALSO require authorization.');
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

console.log('='.repeat(50));
console.log('Testing Transport Commands (Play/Pause/Skip)');
console.log('='.repeat(50));
console.log('Zone: Office');
console.log('Zone Sooid:', OFFICE_ZONE_SOOID.toString('hex'));
console.log('');

testTransport().catch(console.error);
