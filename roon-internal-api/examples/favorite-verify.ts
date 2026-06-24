/**
 * favorite-verify.ts
 *
 * Decisive test of the "is it really auth, or just a stale callback?" hypothesis.
 *
 * Findings that motivated this test (from analyzing full-session.pcap vs
 * fresh-favorite.pcap):
 *  - The local 9332 protocol carries NO auth token/credential/signature.
 *  - The FavoriteOrBan dispatch token `1b 2d` is STABLE across sessions.
 *  - The 4-byte field after the track id is a session-specific ResultCallback
 *    handle: `86 8e f2 47` in one capture, `86 87 93 0f` in another.
 *
 * So the official "silently ignored => needs auth" conclusion may be wrong:
 * the mutation may actually be applied, with the ack routed to a callback
 * handle we never registered (and buried under device-discovery 0x05 noise).
 *
 * This script favorites a known track, filters the noise, and prints every
 * non-streaming message in the 6s window after the call so we can see the
 * real server response (if any). Verify the result in the Roon UI.
 *
 * Usage:  npx ts-node examples/favorite-verify.ts [0|1]
 *   1 (default) = set favorite, 0 = remove favorite
 */
import * as net from 'net';
import * as crypto from 'crypto';

const HOST = 'YOUR_CORE_IP';
const PORT = 9332;
const STATE = process.argv[2] === '0' ? 0x00 : 0x01; // 1=favorite, 0=unfavorite

const SERVER_BROKER_ID = Buffer.from('YOUR_SERVER_BROKER_ID', 'hex');
const MAGIC = Buffer.from('ROON');

const CONNECT_REQUEST_TEMPLATE =
  '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

const SCHEMA_TRIGGER = Buffer.from('420210bcd36e8478a3e111b2725b4a6188709b', 'hex');

// FavoriteOrBan registration (exact bytes from official client)
const FAV_REGISTRATION = Buffer.from(
  '0681138454810f536f6f6c6f6f732e42726f6b65722e4170692e4c6962726172793a3a4661766f726974654f7242616e2853797374656d2e536f6f69642c20536f6f6c6f6f732e42726f6b65722e4170692e547261636b426173652c20536f6f6c6f6f732e42726f6b65722e4170692e4661766f7269746542616e53746174652c20426173652e526573756c7443616c6c6261636b29',
  'hex'
);

// Track reference (19 bytes) captured from the user's own library
const TRACK_REF = Buffer.from('123f01162027273a55d64bbf4a85f335410e2f', 'hex');
// ResultCallback handle. We allocate our own marker; server echoes result here.
const CALLBACK_REF = Buffer.from('868ef247', 'hex');

const CALL_MSGID = 0x55; // distinctive id so we can spot the reply

function buildFavoriteCommand(): Buffer {
  return Buffer.concat([
    Buffer.from([0x43, CALL_MSGID]),
    Buffer.from([0x1b, 0x2d]),
    Buffer.from([0x84, 0x54]),
    TRACK_REF,
    CALLBACK_REF,
    Buffer.from([STATE]),
  ]);
}

function isNoise(buf: Buffer): boolean {
  // 0x05 device-discovery streaming updates referencing _raop._tcp (AirPlay)
  // and 0x41/0xc0 keepalives are noise for our purposes.
  if (buf[0] === 0x41 || (buf[0] === 0xc0 && buf.length <= 4)) return true;
  if (buf[0] === 0x05 && buf.includes(Buffer.from('_raop'))) return true;
  return false;
}

async function main(): Promise<void> {
  const clientBrokerId = crypto.randomBytes(16);
  console.log(`State to set: ${STATE === 1 ? 'FAVORITE' : 'UNFAVORITE'}`);
  console.log(`Client Broker ID: ${clientBrokerId.toString('hex')}`);
  const cmd = buildFavoriteCommand();
  console.log(`Favorite command (${cmd.length}b): ${cmd.toString('hex')}\n`);

  await new Promise<void>((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let total = 0;
    let calledAt = 0;
    socket.setTimeout(40000);

    socket.on('connect', () => {
      step = 1;
      socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), SERVER_BROKER_ID, clientBrokerId]));
    });

    socket.on('data', (data) => {
      total += data.length;

      if (data.length >= 6 && data.subarray(0, 4).toString() === 'ROON') {
        const code = data[5];
        if (step === 1 && code === 0x80) {
          step = 2;
          socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
        } else if (step === 2 && code === 0x82) {
          step = 3;
          socket.write(Buffer.from(CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', clientBrokerId.toString('hex')), 'hex'));
        }
        return;
      }

      if (step === 3 && data[0] === 0x80) {
        step = 4;
        socket.write(SCHEMA_TRIGGER);
        // let schema settle, then register + call
        setTimeout(() => {
          console.log(`[schema settled: ${total} bytes received]`);
          socket.write(FAV_REGISTRATION);
          setTimeout(() => {
            step = 6;
            calledAt = Date.now();
            console.log(`\n>>> sending favorite call (msgid 0x${CALL_MSGID.toString(16)})\n`);
            socket.write(cmd);
            // capture window
            setTimeout(() => {
              console.log('\n[6s window elapsed — disconnecting]');
              socket.end();
            }, 6000);
          }, 800);
        }, 3500);
        return;
      }

      // After the call: surface anything that is NOT discovery/keepalive noise,
      // and anything echoing our msgid (0x55) or track ref.
      if (step === 6) {
        const echoesId = data.includes(Buffer.from([CALL_MSGID]));
        const echoesTrack = data.includes(TRACK_REF.subarray(0, 8));
        if (!isNoise(data) || echoesId || echoesTrack) {
          const dt = Date.now() - calledAt;
          const ascii = data.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
          console.log(`[+${dt}ms] type=0x${data[0].toString(16)} len=${data.length}${echoesId ? ' [ECHOES MSGID]' : ''}${echoesTrack ? ' [ECHOES TRACK]' : ''}`);
          console.log(`   hex:   ${data.subarray(0, 64).toString('hex')}`);
          console.log(`   ascii: ${ascii.substring(0, 64)}`);
        }
      }
    });

    socket.on('timeout', () => { console.log('[timeout]'); socket.end(); });
    socket.on('close', () => resolve());
    socket.on('error', (e) => { console.error(`[error] ${e.message}`); resolve(); });
    socket.connect(PORT, HOST);
  });

  console.log('\nDone. Now check the track in the Roon UI to see if its favorite state changed.');
}

main().catch(console.error);
