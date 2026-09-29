import { randomBytes } from 'node:crypto';
import { WebSocket, createWebSocketStream } from 'ws';
import { connectorProof } from '../../dist-electron/chromeConnectorWebSocket.js';

export const extensionOrigin = 'chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln';
export async function pairedClient(code, options = {}) {
  const { browser = 'chrome', ...socketOptions } = options;
  const [, port, id, secret] = code.split('.');
  const nonce = randomBytes(32).toString('hex');
  const client = new WebSocket(`ws://127.0.0.1:${port}/connect`, ['cardbush-v2',
    `auth.${id}.${nonce}.${connectorProof(secret, `upgrade:${id}:${nonce}`)}`], { origin: extensionOrigin, ...socketOptions });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { client.terminate(); reject(new Error('Pairing timed out')); }, 6000);
    const cleanup = () => { clearTimeout(timeout); client.off('message', receive); client.off('close', close); client.off('error', error); };
    const close = () => { cleanup(); reject(new Error('Pairing rejected')); };
    const error = err => { cleanup(); reject(err); };
    const receive = data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'connector_ready') { cleanup(); resolve(); return; }
        const transcript = `${id}:${nonce}:${message.nonce}`;
        if (message.type !== 'challenge' || message.proof !== connectorProof(secret, `server:${transcript}`)) throw new Error('Untrusted server');
        client.send(JSON.stringify({ type: 'authenticate', browser, proof: connectorProof(secret, `client:${transcript}:${browser}`) }));
      } catch (err) { error(err); client.terminate(); }
    };
    client.on('message', receive); client.on('close', close); client.on('error', error);
  });
  client.on('error', () => {});
  const stream = createWebSocketStream(client, { encoding: 'utf8', decodeStrings: false });
  client.once('close', () => stream.destroy());
  return stream;
}
