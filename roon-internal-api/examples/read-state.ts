/**
 * Read current state from Roon using the streaming updates
 *
 * We receive 0x05 messages continuously with:
 * - Device info (AirPlay devices, endpoints)
 * - Playback state (position, volume)
 * - Zone status
 * - Network device discovery
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';
const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

interface DeviceInfo {
  name?: string;
  ip?: string;
  type?: string;
}

interface PlaybackInfo {
  position?: number;
  volume?: number;
  state?: string;
}

async function readState(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  const devices: Map<string, DeviceInfo> = new Map();
  const playbackUpdates: PlaybackInfo[] = [];
  let messageCount = 0;
  let schemaReceived = false;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;

    socket.setTimeout(20000);

    socket.on('connect', () => {
      console.log('Connecting to Roon...\n');
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
        console.log('Connected! Triggering schema...\n');
        socket.write(SCHEMA_TRIGGER);
      }
      else if (step === 4) {
        messageCount++;

        // Parse streaming updates (0x05 messages)
        if (data[0] === 0x05) {
          const text = data.toString('utf8');

          // Extract device names (AirPlay, Chromecast, etc.)
          const deviceMatch = text.match(/Slartibartfast|HQ-\d+|AirPlay|Chromecast/g);
          if (deviceMatch) {
            deviceMatch.forEach(d => {
              if (!devices.has(d)) {
                devices.set(d, { name: d });
                console.log(`[Device] Found: ${d}`);
              }
            });
          }

          // Extract IP addresses
          const ipMatch = text.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g);
          if (ipMatch) {
            ipMatch.forEach(ip => {
              if (!devices.has(ip) && !ip.startsWith('0.')) {
                devices.set(ip, { ip, type: 'network' });
              }
            });
          }

          // Look for volume/playback data (hex patterns)
          // Volume is often encoded as a float in the binary data
          const hex = data.toString('hex');
          if (hex.includes('85d0da74')) {  // Known playback marker
            playbackUpdates.push({ state: 'update' });
          }
        }

        // Track schema completion
        if (data[0] === 0x07 && !schemaReceived) {
          schemaReceived = true;
          console.log('[Schema] Receiving type definitions...');
        }

        // Show progress
        if (messageCount % 50 === 0) {
          console.log(`[Progress] ${messageCount} messages received`);
        }
      }
    });

    socket.on('timeout', () => {
      console.log('\n' + '='.repeat(50));
      console.log('State Summary');
      console.log('='.repeat(50));

      console.log(`\nTotal messages: ${messageCount}`);
      console.log(`Playback updates: ${playbackUpdates.length}`);

      console.log(`\nDevices found (${devices.size}):`);
      devices.forEach((info, key) => {
        console.log(`  - ${key}: ${JSON.stringify(info)}`);
      });

      console.log('\nUnique IPs seen:');
      const ips = [...devices.values()]
        .filter(d => d.ip)
        .map(d => d.ip);
      [...new Set(ips)].forEach(ip => console.log(`  - ${ip}`));

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

console.log('Roon State Reader');
console.log('=================\n');
console.log('Reading streaming updates for 20 seconds...\n');

readState().catch(console.error);
