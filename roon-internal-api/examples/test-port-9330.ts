/**
 * Test the public extension API on port 9330
 *
 * This uses the MOO/1 text protocol (not the binary protocol on 9332)
 * The extension API may allow access to browse/favorites without cloud auth
 */

import * as net from 'net';

const HOST = 'YOUR_CORE_IP';
const PORT = 9330;

// MOO/1 protocol uses \n line endings
function buildMooRequest(verb: string, headers: Record<string, string>, body?: string): Buffer {
  let msg = `MOO/1 ${verb}\n`;
  for (const [key, value] of Object.entries(headers)) {
    msg += `${key}: ${value}\n`;
  }
  if (body) {
    msg += `Content-Length: ${Buffer.byteLength(body)}\n`;
    msg += `Content-Type: application/json\n`;
  }
  msg += '\n';
  if (body) {
    msg += body;
  }
  return Buffer.from(msg);
}

async function testExtensionAPI(): Promise<void> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let responseData = '';
    let requestId = 1;

    socket.on('connect', () => {
      console.log('Connected to Roon Extension API (port 9330)\n');

      // First, send a registry info request
      const infoRequest = buildMooRequest('REQUEST', {
        'Request-Id': String(requestId++),
        'Service': 'com.roonlabs.registry:1',
        'Name': 'info'
      });

      console.log('Sending registry info request...');
      console.log('Request:\n' + infoRequest.toString());
      socket.write(infoRequest);
    });

    socket.on('data', (data) => {
      responseData += data.toString();
      console.log('Received data (' + data.length + ' bytes):\n' + data.toString().substring(0, 500));

      // Parse MOO/1 response
      const lines = responseData.split('\n');
      if (lines[0].startsWith('MOO/1')) {
        console.log('\nResponse status:', lines[0]);

        // After info response, try to register as an extension
        if (responseData.includes('Success') || responseData.includes('COMPLETE')) {
          setTimeout(() => {
            sendRegistration();
          }, 1000);
        }
      }
    });

    function sendRegistration() {
      console.log('\n--- Attempting extension registration ---\n');

      const regBody = JSON.stringify({
        extension_id: 'com.test.favorites-reader',
        display_name: 'Favorites Reader',
        display_version: '1.0.0',
        publisher: 'Test',
        email: 'test@example.com',
        required_services: [],
        optional_services: ['com.roonlabs.browse:1'],
        provided_services: [],
        website: ''
      });

      const regRequest = buildMooRequest('REQUEST', {
        'Request-Id': String(requestId++),
        'Service': 'com.roonlabs.registry:1',
        'Name': 'register'
      }, regBody);

      console.log('Registration request:\n' + regRequest.toString().substring(0, 300) + '...');
      socket.write(regRequest);
    }

    socket.on('error', (err) => {
      console.error('Socket error:', err.message);
    });

    socket.on('close', () => {
      console.log('\n--- Connection closed ---');
      console.log('Total response:', responseData.length, 'bytes');
      resolve();
    });

    // Close after 15 seconds
    setTimeout(() => {
      console.log('\n--- Timeout, closing ---');
      socket.end();
    }, 15000);

    socket.connect(PORT, HOST);
  });
}

console.log('='.repeat(50));
console.log('Testing Roon Extension API (Port 9330)');
console.log('='.repeat(50));
console.log('');

testExtensionAPI().catch(console.error);
