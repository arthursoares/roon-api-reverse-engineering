/**
 * Basic usage example for roon-internal-api
 *
 * This example shows how to connect to a Roon Core and use the library service.
 * Run with: npx ts-node examples/basic-usage.ts
 */

import { RoonInternalClient, sooidFromHex } from '../src';

async function main() {
  // Create client - replace with your Roon Core IP
  const client = new RoonInternalClient({
    host: 'YOUR_CORE_IP',
    port: 9332,
    autoReconnect: true,
    requestTimeout: 10000,
  });

  // Set up event handlers
  client.on('connected', () => {
    console.log('Connected to Roon Core!');
  });

  client.on('disconnected', (hadError) => {
    console.log('Disconnected from Roon Core', hadError ? '(with error)' : '');
  });

  client.on('error', (err) => {
    console.error('Error:', err.message);
  });

  try {
    // Connect to the Roon Core
    console.log('Connecting...');
    await client.connect();

    // Example: Favorite a track
    // You'll need to get the actual Sooid from Roon (via traffic capture or other means)
    const trackId = sooidFromHex('0102030405060708090a0b0c0d0e0f10');

    console.log('Setting favorite...');
    await client.library.setFavorite(trackId, true);
    console.log('Track favorited!');

    // Or use convenience methods
    // await client.library.favorite(trackId);
    // await client.library.unfavorite(trackId);

    // Disconnect when done
    await client.disconnect();
    console.log('Done!');
  } catch (err) {
    console.error('Failed:', err);
    process.exit(1);
  }
}

main();
