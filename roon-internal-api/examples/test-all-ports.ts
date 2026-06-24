/**
 * Test all discovered Roon ports with various protocols
 */

import * as net from 'net';
import WebSocket from 'ws';

const HOST = 'YOUR_CORE_IP';

// SOOD (Sooloos discovery) packet - used for service discovery
const SOOD_QUERY = Buffer.from([
  0x53, 0x4f, 0x4f, 0x44, // "SOOD" magic
  0x02, // Query type
  0x00  // No payload
]);

async function testRawProtocol(port: number): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n--- Port ${port} Raw TCP ---`);

    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.on('connect', () => {
      console.log('Connected');

      // Try sending different probe bytes
      const probes = [
        { name: 'SOOD', data: SOOD_QUERY },
        { name: 'ROON', data: Buffer.from('ROON\x01\x00') },
        { name: 'HTTP', data: Buffer.from('GET / HTTP/1.1\r\nHost: ' + HOST + '\r\n\r\n') },
        { name: 'JSON', data: Buffer.from('{"type":"info"}') },
      ];

      let probeIndex = 0;
      const tryNextProbe = () => {
        if (probeIndex >= probes.length) {
          socket.end();
          return;
        }
        const probe = probes[probeIndex++];
        console.log(`  Trying ${probe.name}...`);
        socket.write(probe.data);
      };

      tryNextProbe();

      // Also set up a timer for next probe
      const probeInterval = setInterval(() => {
        tryNextProbe();
      }, 500);

      setTimeout(() => {
        clearInterval(probeInterval);
        socket.end();
      }, 3000);
    });

    socket.on('data', (data) => {
      console.log(`  Received ${data.length} bytes:`);
      console.log('    Hex:', data.subarray(0, 32).toString('hex'));
      console.log('    Text:', data.toString('utf8').substring(0, 100).replace(/[^ -~]/g, '.'));
    });

    socket.on('timeout', () => {
      console.log('  Timeout');
      socket.destroy();
      resolve();
    });

    socket.on('error', (err) => {
      console.log('  Error:', err.message);
      resolve();
    });

    socket.on('close', () => {
      resolve();
    });

    socket.connect(port, HOST);
  });
}

async function testWebSocketWithVariants(port: number): Promise<void> {
  const paths = ['/api', '/', '/roon'];

  for (const path of paths) {
    await new Promise<void>((resolve) => {
      const url = `ws://${HOST}:${port}${path}`;
      console.log(`\n--- WebSocket ${url} ---`);

      const ws = new WebSocket(url, { timeout: 3000 });

      const timer = setTimeout(() => {
        console.log('  Timeout waiting for response');
        ws.terminate();
        resolve();
      }, 5000);

      ws.on('open', () => {
        console.log('  Connected');

        // Try different MOO/1 formats
        // Format 1: Standard with newlines
        const moo1 = 'MOO/1 REQUEST\nRequest-Id: 1\nService: com.roonlabs.registry:1\nName: info\n\n';

        // Format 2: With Content-Type header
        const moo2 = 'MOO/1 REQUEST\nRequest-Id: 2\n\n';

        console.log('  Sending MOO/1 info request...');
        ws.send(moo1);

        setTimeout(() => {
          console.log('  Sending minimal MOO/1 request...');
          ws.send(moo2);
        }, 1000);
      });

      ws.on('message', (data) => {
        clearTimeout(timer);
        const msg = data.toString();
        console.log('  *** RECEIVED MESSAGE ***');
        console.log('  Length:', msg.length);
        console.log('  Content:', msg.substring(0, 300));
        setTimeout(() => {
          ws.close();
          resolve();
        }, 500);
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        console.log('  Error:', err.message);
        resolve();
      });

      ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Testing All Discovered Roon Ports');
  console.log('='.repeat(50));

  const ports = [9150, 9200, 9330, 9332];

  // Test raw TCP on each port
  for (const port of ports) {
    await testRawProtocol(port);
  }

  // Test WebSocket variants on likely ports
  for (const port of [9330, 9200]) {
    await testWebSocketWithVariants(port);
  }

  console.log('\n' + '='.repeat(50));
  console.log('Done');
}

main().catch(console.error);
