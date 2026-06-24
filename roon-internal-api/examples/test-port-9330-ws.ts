/**
 * Test port 9330 with proper WebSocket framing
 */

import WebSocket from 'ws';

const HOST = 'YOUR_CORE_IP';
const PORT = 9330;

async function testExtensionAPI(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`Connecting to ws://${HOST}:${PORT}/api...`);

    const ws = new WebSocket(`ws://${HOST}:${PORT}/api`);
    let requestId = 1;

    ws.on('open', () => {
      console.log('WebSocket connected!\n');

      // Send a MOO/1 info request to registry service
      const infoRequest = [
        'MOO/1 REQUEST',
        'Request-Id: ' + requestId++,
        'Service: com.roonlabs.registry:1',
        'Name: info',
        '',
        ''
      ].join('\n');

      console.log('Sending registry info request...');
      ws.send(infoRequest);
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      console.log('\n--- Received Message ---');
      console.log(msg.substring(0, 1000));

      // Parse the response
      const lines = msg.split('\n');
      if (lines[0].includes('COMPLETE')) {
        console.log('\n*** Registry responded! ***');

        // Now try to register as an extension
        setTimeout(() => {
          sendRegistration();
        }, 500);
      }
    });

    function sendRegistration() {
      console.log('\n--- Sending Extension Registration ---\n');

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

      const regRequest = [
        'MOO/1 REQUEST',
        'Request-Id: ' + requestId++,
        'Service: com.roonlabs.registry:1',
        'Name: register',
        'Content-Type: application/json',
        'Content-Length: ' + Buffer.byteLength(regBody),
        '',
        regBody
      ].join('\n');

      console.log('Registration request (truncated):');
      console.log(regRequest.substring(0, 300) + '...');
      ws.send(regRequest);
    }

    ws.on('error', (err) => {
      console.log('WebSocket error:', err.message);
    });

    ws.on('close', (code, reason) => {
      console.log('\n--- WebSocket closed ---');
      console.log('Code:', code, 'Reason:', reason.toString());
      resolve();
    });

    // Close after 20 seconds
    setTimeout(() => {
      console.log('\n--- Timeout, closing ---');
      ws.close();
    }, 20000);
  });
}

console.log('='.repeat(50));
console.log('Testing Roon Extension API (Port 9330 WebSocket)');
console.log('='.repeat(50));
console.log('');

testExtensionAPI().catch(console.error);
