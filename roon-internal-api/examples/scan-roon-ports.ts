/**
 * Scan for Roon services on common ports
 */

import * as net from 'net';
import WebSocket from 'ws';

const HOST = 'YOUR_CORE_IP';

const PORTS_TO_TEST = [
  9100, 9150, 9200, 9300, 9330, 9332, 9400, 9500,
  8080, 8000, 3000, 3001, 80, 443
];

const WS_PATHS = ['/', '/api', '/roon', '/ws', '/websocket'];

async function testTcpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);

    socket.on('connect', () => {
      console.log(`  Port ${port}: OPEN (TCP)`);
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.connect(port, HOST);
  });
}

async function testWebSocket(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `ws://${HOST}:${port}${path}`;
    const ws = new WebSocket(url, { timeout: 3000 });

    const timer = setTimeout(() => {
      ws.terminate();
      resolve(false);
    }, 3000);

    ws.on('open', () => {
      clearTimeout(timer);
      console.log(`  WebSocket ${url}: CONNECTED`);

      // Try sending MOO/1 request
      const request = [
        'MOO/1 REQUEST',
        'Request-Id: 1',
        'Service: com.roonlabs.registry:1',
        'Name: info',
        '',
        ''
      ].join('\n');
      ws.send(request);

      // Wait for response
      setTimeout(() => {
        ws.close();
        resolve(true);
      }, 2000);
    });

    ws.on('message', (data) => {
      console.log(`  WebSocket ${url} received: ${data.toString().substring(0, 100)}...`);
    });

    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function main() {
  console.log('='.repeat(50));
  console.log(`Scanning Roon services on ${HOST}`);
  console.log('='.repeat(50));
  console.log('');

  console.log('--- TCP Port Scan ---');
  const openPorts: number[] = [];
  for (const port of PORTS_TO_TEST) {
    const isOpen = await testTcpPort(port);
    if (isOpen) {
      openPorts.push(port);
    }
  }

  if (openPorts.length === 0) {
    console.log('No open ports found');
    return;
  }

  console.log('\n--- WebSocket Tests ---');
  for (const port of openPorts) {
    for (const path of WS_PATHS) {
      await testWebSocket(port, path);
    }
  }

  console.log('\nDone');
}

main().catch(console.error);
