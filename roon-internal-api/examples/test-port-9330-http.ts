/**
 * Test port 9330 with HTTP to understand the protocol
 */

import * as http from 'http';
import * as net from 'net';

const HOST = 'YOUR_CORE_IP';
const PORT = 9330;

async function testWithHTTP(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`Trying HTTP GET to http://${HOST}:${PORT}/...`);

    const req = http.get(`http://${HOST}:${PORT}/`, (res) => {
      console.log('HTTP Status:', res.statusCode);
      console.log('Headers:', JSON.stringify(res.headers, null, 2));

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log('Body:', data.substring(0, 500));
        resolve();
      });
    });

    req.on('error', (err) => {
      console.log('HTTP error:', err.message);
      resolve();
    });

    req.setTimeout(5000, () => {
      console.log('HTTP timeout');
      req.destroy();
      resolve();
    });
  });
}

async function testWebSocketUpgrade(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\nTrying WebSocket upgrade to http://${HOST}:${PORT}/api...`);

    const options = {
      hostname: HOST,
      port: PORT,
      path: '/api',
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13'
      }
    };

    const req = http.request(options, (res) => {
      console.log('Response Status:', res.statusCode);
      console.log('Response Headers:', JSON.stringify(res.headers, null, 2));
    });

    req.on('upgrade', (res, socket, _head) => {
      console.log('WebSocket upgraded!');
      console.log('Upgrade response:', res.statusCode);

      // Try sending MOO/1 request
      const mooRequest = [
        'MOO/1 REQUEST',
        'Request-Id: 1',
        'Service: com.roonlabs.registry:1',
        'Name: info',
        '',
        ''
      ].join('\n');

      console.log('\nSending MOO/1 request via WebSocket...');
      socket.write(mooRequest);

      socket.on('data', (data: Buffer) => {
        console.log('WS Response:', data.toString().substring(0, 500));
      });

      setTimeout(() => {
        socket.end();
        resolve();
      }, 5000);
    });

    req.on('error', (err) => {
      console.log('Request error:', err.message);
      resolve();
    });

    req.setTimeout(5000, () => {
      console.log('Request timeout');
      req.destroy();
      resolve();
    });

    req.end();
  });
}

async function testRawWithDelays(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\nTrying raw TCP with small initial packet...`);

    const socket = new net.Socket();

    socket.on('connect', () => {
      console.log('Connected');

      // Maybe the server expects a specific handshake?
      // Let's try sending just a few bytes first
      console.log('Waiting 1s before sending...');

      setTimeout(() => {
        // Try the registry info request
        const request = Buffer.from([
          'MOO/1 REQUEST',
          'Request-Id: 1',
          'Service: com.roonlabs.registry:1',
          'Name: info',
          '',
          ''
        ].join('\n'));

        console.log('Sending MOO/1 request...');
        socket.write(request);
      }, 1000);
    });

    socket.on('data', (data) => {
      console.log('Raw response (' + data.length + ' bytes):');
      console.log('Hex:', data.subarray(0, 50).toString('hex'));
      console.log('Text:', data.toString().substring(0, 200));
    });

    socket.on('error', (err) => {
      console.log('Socket error:', err.message);
    });

    socket.on('close', () => {
      console.log('Socket closed');
      resolve();
    });

    setTimeout(() => {
      socket.end();
    }, 8000);

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log('='.repeat(50));
  console.log('Testing Port 9330 Protocol Detection');
  console.log('='.repeat(50));
  console.log('');

  await testWithHTTP();

  console.log('\n' + '-'.repeat(50));

  await testWebSocketUpgrade();

  console.log('\n' + '-'.repeat(50));

  await testRawWithDelays();
}

main().catch(console.error);
