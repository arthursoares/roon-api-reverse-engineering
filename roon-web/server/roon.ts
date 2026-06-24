/**
 * Single persistent RoonClient connection to the core, shared by the whole
 * backend. Object ids are session-scoped, so we keep exactly one connection.
 */
import { RoonClient } from '../../roon-internal-api/src/index';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from(
  process.env.ROON_SERVER_BROKER_ID || 'YOUR_SERVER_BROKER_ID',
  'hex'
);

let client: RoonClient | null = null;
let connecting: Promise<RoonClient> | null = null;

export async function getRoon(): Promise<RoonClient> {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const c = new RoonClient({ host: HOST, serverBrokerId: SERVER_BROKER_ID });
      await c.connect();
      client = c;
      return c;
    })();
    connecting.catch(() => {
      connecting = null; // allow retry on next request
    });
  }
  return connecting;
}

export function currentRoon(): RoonClient | null {
  return client;
}
