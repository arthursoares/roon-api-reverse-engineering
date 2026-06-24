/**
 * Example showing how to use roon-internal-api alongside node-roon-api
 *
 * This demonstrates the recommended approach: use node-roon-api for discovery
 * and standard operations, and roon-internal-api for extended functionality.
 *
 * Note: This requires node-roon-api to be installed:
 *   npm install node-roon-api
 */

import { RoonInternalClient, sooidFromHex } from '../src';

// TypeScript interface for the minimal Roon API types we need
interface RoonCore {
  moo: {
    transport: {
      host: string;
    };
  };
}

// Placeholder for RoonApi - you would import this from 'node-roon-api'
// import RoonApi from 'node-roon-api';

async function main() {
  console.log(`
This example shows the pattern for using roon-internal-api with node-roon-api.

In a real implementation, you would:

1. Use node-roon-api to discover and connect to Roon Core
2. In the core_paired callback, get the host from core.moo.transport.host
3. Create a RoonInternalClient with that host
4. Use both APIs together

Example code structure:
`);

  const exampleCode = `
const RoonApi = require('node-roon-api');
const { RoonInternalClient } = require('roon-internal-api');

let internalClient: RoonInternalClient | null = null;

const roon = new RoonApi({
  extension_id: 'com.example.my-extension',
  display_name: 'My Extension',
  display_version: '1.0.0',
  publisher: 'Me',

  core_paired: async (core) => {
    console.log('Core paired:', core.display_name);

    // Create internal client using the same host
    internalClient = new RoonInternalClient({
      host: core.moo.transport.host,
      autoReconnect: true,
    });

    internalClient.on('connected', () => {
      console.log('Internal API connected!');
    });

    await internalClient.connect();

    // Now you can use both APIs:
    // - core.services.* for standard extension API
    // - internalClient.library.* for internal functionality
  },

  core_unpaired: (core) => {
    if (internalClient) {
      internalClient.disconnect();
      internalClient = null;
    }
  },
});

roon.start_discovery();
`;

  console.log(exampleCode);
}

main();
