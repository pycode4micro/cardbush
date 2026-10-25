import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { extensionOrigin } from './chrome-paired-client.mjs';

const source = await readFile(new URL('../../assets/plugins/chrome/extension/connector-transport.js', import.meta.url), 'utf8');
export async function approvalClient(port, identity, options = {}) {
  const { origin = extensionOrigin, browser = 'chrome', ...rest } = options;
  const context = vm.createContext({ crypto: webcrypto, Uint8Array, TextEncoder, AbortController, setTimeout, clearTimeout,
    navigator: { userAgent: browser === 'edge' ? 'Edg/130' : 'Chrome/130' },
    WebSocket: class extends WebSocket { constructor(url, protocols) { super(url, protocols, { origin }); } },
  });
  vm.runInContext(source, context);
  return vm.runInContext('requestConnectorPairing', context)(identity, { ports: [Number(port)], attemptTimeoutMs: 1500,
    onPrepared: async (code, confirmed = false) => { identity.pending = code; identity.confirmed = confirmed; }, confirm: async () => true, ...rest });
}
