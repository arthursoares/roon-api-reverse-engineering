/**
 * Send multiple requests rapidly - like the tests that got responses
 */

import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE = '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

function buildMethodCall(msgId: number, typeName: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x47, msgId & 0xff]));
  parts.push(Buffer.from([0x81, 0x67, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  parts.push(Buffer.from([typeName.length]));
  parts.push(Buffer.from(typeName));
  parts.push(Buffer.from([0x05, 0x03, 0x05, 0x03]));
  return Buffer.concat(parts);
}

async function test(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let msgId = 10;
    const pending = new Map<number, string>();

    socket.setTimeout(30000);

    socket.on('connect', () => {
      console.log('Connected\n');
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        }
        else if (step === 2 && code === 0x82) {
          step = 3;
          const connectReq = Buffer.from(
            CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')),
            'hex'
          );
          socket.write(connectReq);
        }
      }
      else if (step === 3 && data[0] === 0x80) {
        step = 4;
        console.log('Session ready - sending 5 requests rapidly:\n');

        // Send 5 requests immediately (no delay)
        const methods = [
          'Sooloos.Msg.Library.VirtualAlbumQueryRequest',
          'Sooloos.Msg.Library.BrowseAlbumsRequest',
          'Sooloos.Msg.Library.GetInfoRequest',
          'Sooloos.Msg.Library.SearchRequest',
          'Sooloos.Msg.Library.GetProfileRequest',
        ];

        for (const method of methods) {
          msgId++;
          pending.set(msgId, method.replace('Sooloos.Msg.', '').replace('Request', ''));
          console.log(`  Sending msgId=${msgId}: ${pending.get(msgId)}`);
          socket.write(buildMethodCall(msgId, method));
        }

        console.log('\nWaiting for responses...\n');

        // Wait and then report
        setTimeout(() => {
          console.log(`\nGot responses for ${5 - pending.size} out of 5 requests`);
          console.log('Still pending:');
          for (const [id, name] of pending) {
            console.log(`  msgId=${id}: ${name}`);
          }
          socket.end();
        }, 5000);
      }
      else if (step === 4) {
        const respMsgId = data[1];
        const types = data.toString('utf8').match(/Sooloos\.[A-Za-z.]+/g) || [];
        const reqName = pending.get(respMsgId) || 'unknown';

        console.log(`Response msgId=${respMsgId} (${reqName}): ${types.join(', ')}`);
        pending.delete(respMsgId);
      }
    });

    socket.on('close', () => {
      console.log('\nDone');
      resolve();
    });

    socket.on('error', console.error);
    socket.connect(PORT, HOST);
  });
}

test().catch(console.error);
