import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PluginNetwork } from '../dist-electron/pluginNetwork.mjs';
import { ProxyFetchPool } from '../dist-electron/proxyFetch.mjs';
import { defaultPluginProxy, pluginProxySchema, networkProxySchema, resolvePluginProxy, pluginProxyEnvironment } from '../packages/bush-protocol/dist/index.js';
import { CardbushAppsConfigStore, ProductMcpConfigStore } from '../packages/cardbush-product-host/dist/index.js';
import { mergeMcpServer } from '../dist-electron/productMcpManagement.mjs';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const config = (mode, extra = {}) => pluginProxySchema.parse({ mode, ...extra });
const direct = config('none');
const listen = async (server, t) => {
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
};
async function setup(t, resolveSystem = async () => 'DIRECT') {
  const parent = resolve('tmp'), root = await mkdtemp(join(parent, 'plugin-proxy-'));
  const file = join(root, 'apps.json'), sessions = [];
  const network = new PluginNetwork(file, partition => {
    const session = { partition, settings: {}, async setProxy(settings) { this.settings = settings; }, async resolveProxy(target) {
      if (this.settings.mode === 'system') return resolveSystem(target);
      const url = new URL(target);
      if (this.settings.proxyBypassRules.split(';').includes(url.hostname)) return 'DIRECT';
      const rule = this.settings.proxyRules.split(';').find(rule => rule.startsWith(`${url.protocol.slice(0, -1)}=`));
      if (!rule) return 'DIRECT';
      const proxy = new URL(rule.slice(rule.indexOf('=') + 1));
      return `${proxy.protocol.startsWith('socks') ? 'SOCKS5' : proxy.protocol === 'https:' ? 'HTTPS' : 'PROXY'} ${proxy.host}`;
    } }; sessions.push(session); return session;
  });
  const pool = new ProxyFetchPool();
  t.after(async () => { await pool.close(); await network.close(); assert.equal(resolve(root, '..'), parent); await rm(root, { recursive: true, force: true }); });
  return { network, pool, sessions, file, root };
}
async function proxy(t, tag) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, kind: 'http' });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag, result: { structuredContent: null, content: [{ type: 'text', text: '原始输出\r\n' }] } }));
  });
  server.on('connect', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, kind: 'connect' });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', bytes => socket.write(`${tag}:${bytes.toString()}`));
  });
  return { url: await listen(server, t), seen };
}
async function tunnel(endpoint, authority) {
  const address = new URL(endpoint);
  const req = request(address, { method: 'CONNECT', path: authority, agent: false,
    headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${address.username}:${address.password}`).toString('base64')}` } });
  req.end(); const [res, socket] = await once(req, 'connect');
  assert.equal(res.statusCode, 200);
  socket.write('echo'); const [bytes] = await once(socket, 'data'); socket.destroy(); return bytes.toString();
}

test('proxy precedence, defaults, stable effective identity and address validation', () => {
  const model = config('manual', { httpProxy: '127.0.0.1:8181', httpsProxy: '127.0.0.1:8282' });
  assert.deepEqual(resolvePluginProxy(model), model);
  assert.equal(defaultPluginProxy().mode, 'model');
  for (const global of ['model', 'none', 'system', 'manual']) for (const local of ['model', 'none', 'system', 'manual']) {
    assert.equal(resolvePluginProxy(model, config(global), config(local)).mode, local === 'model' ? 'manual' : local);
  }
  assert.deepEqual(resolvePluginProxy(model, config('none', { httpProxy: 'localhost:1234' })), direct);
  for (const invalid of ['ftp://proxy:80', 'http://host/path', 'http://host?secret=1', 'http://host/#x', 'http://host:99999'])
    assert.equal(pluginProxySchema.safeParse({ mode: 'manual', httpProxy: invalid }).success, false);
  for (const mode of ['model', 'none', 'system']) {
    const inactive = config(mode, { httpProxy: 'http://host:99999' });
    assert.equal(inactive.httpProxy, 'http://host:99999', 'inactive form values are retained without blocking other modes');
    assert.deepEqual(resolvePluginProxy(direct, inactive), mode === 'system' ? config('system') : direct);
    assert.equal(pluginProxySchema.safeParse({ ...inactive, mode: 'manual' }).success, false, 'reactivating manual mode validates the addresses');
  }
  for (const address of ['localhost:8080', 'https://proxy:443', 'socks5h://proxy:1080', 'http://[::1]:8080', 'http://user:pass@proxy:80'])
    assert.equal(pluginProxySchema.safeParse({ mode: 'manual', httpProxy: address }).success, true);
});

test('store migrates old configs, preserves global settings through other edits, saves built-in overrides and resets inheritance', async t => {
  const { root } = await setup(t), file = join(root, 'persist.json'), store = new CardbushAppsConfigStore(file);
  const initial = await store.read(); assert.equal(initial.proxy.mode, 'model');
  const changed = await store.write({ ...initial, proxy: config('system'), plugins: initial.plugins.map(plugin => ({ ...plugin, config: { ...plugin.config, proxy: config('none') } })) });
  assert.equal((await new CardbushAppsConfigStore(file).read()).plugins[0].config.proxy.mode, 'none');
  const legacyUpdate = { ...changed }; delete legacyUpdate.proxy;
  assert.equal((await store.write(legacyUpdate)).proxy.mode, 'system');
  const current = await store.read(); delete current.plugins[0].config.proxy;
  assert.equal((await store.write(current)).plugins[0].config.proxy, undefined);
  const bytes = await readFile(file, 'utf8');
  await assert.rejects(store.write({ ...current, proxy: { mode: 'auto' } }));
  assert.equal(await readFile(file, 'utf8'), bytes, 'invalid proxy does not overwrite configuration');
});

test('MCP proxy batch reset preserves every other stored field and rejects concurrent configuration edits', async t => {
  const { root } = await setup(t), store = new ProductMcpConfigStore(join(root, 'mcp-servers.json'));
  const originals = ['first', 'second'].map((id, index) => ({ id, name: id, description: 'fixture', enabled: true,
    transport: 'stdio', command: process.execPath, args: [], env: { KEEP: 'unchanged' },
    proxy: config(index ? 'manual' : 'model', { httpProxy: 'http://localhost:7890' }),
    enabled_tools: ['read'], oauth: { scopes: ['fixture.read'] }, extension: { nested: { retain: true } },
  }));
  await store.write({ servers: originals });
  const product = await loadChatTranscript({ source: `export * from ${JSON.stringify(resolve('src/backend/productMcp.ts'))};`, globals: {
    window: { cardbushDesktop: { productHostCommand: async command => ({ ok: true,
      value: command.kind === 'mcp.get' ? await store.read() : await store.write(command.config),
    }) } },
  } });
  const applied = [], runtime = { applyMcpSnapshot: async value => { applied.push(value); return value; } };
  const current = await product.readProductMcpConfiguration();
  await product.replaceProductMcpServers(runtime, current.servers.map(server => ({ ...server, proxy: undefined })), current.revision);
  const saved = await store.read();
  assert.deepEqual(saved.servers, originals.map(({ proxy: _proxy, ...server }) => server));
  assert.equal(saved.revision, current.revision + 1, 'one revision for the whole MCP batch');
  assert.equal(applied.length, 1);
  const stale = await product.readProductMcpConfiguration();
  const external = await store.write({ servers: saved.servers.map(server => ({ ...server, env: { KEEP: 'new external value' } })) });
  await assert.rejects(product.replaceProductMcpServers(runtime, stale.servers, stale.revision), /configuration changed/);
  assert.deepEqual(await store.read(), external, 'a stale UI cannot overwrite a newer configuration');
  assert.equal(applied.length, 1, 'a failed transaction never applies its stale snapshot');
});

test('independent plugin routes preserve raw HTTP output, authenticate only to the proxy and select HTTP versus HTTPS', async t => {
  const a = await proxy(t, 'A'), b = await proxy(t, 'B');
  const { network, pool, file, sessions } = await setup(t);
  network.setModel(config('manual', { httpProxy: b.url, httpsProxy: b.url }));
  await writeFile(file, JSON.stringify({ proxy: config('manual', { httpProxy: a.url, httpsProxy: b.url }), plugins: [
    { id: 'custom', config: { proxy: config('manual', { httpProxy: b.url, httpsProxy: a.url }) } },
    { id: 'model', config: { proxy: config('model') } }, { id: 'direct', config: { proxy: direct } },
  ] }));
  const configuration = await network.configuration();
  const endpoints = await Promise.all([network.endpoint(configuration.default), network.endpoint(configuration.plugins.custom)]);
  const results = await Promise.all(endpoints.map(endpoint => pool.forEndpoint(endpoint)('http://fixture.invalid/result', { headers: { Authorization: 'Bearer fixture-origin' } }).then(res => res.json())));
  assert.deepEqual(results.map(item => item.tag), ['A', 'B']);
  assert.equal(results[0].result.structuredContent, null);
  assert.equal(results[0].result.content[0].text, '原始输出\r\n');
  assert.equal(a.seen[0].headers.authorization, 'Bearer fixture-origin');
  assert.equal(a.seen[0].headers['proxy-authorization'], undefined, 'local gateway credential is never sent to upstream or origin');
  assert.equal(await tunnel(endpoints[0], 'fixture.invalid:443'), 'B:echo');
  assert.equal(await tunnel(endpoints[1], 'fixture.invalid:443'), 'A:echo');
  assert.equal(await network.endpoint(configuration.plugins.direct), '');
  const same = await Promise.all(Array.from({ length: 12 }, () => network.endpoint(configuration.default)));
  assert.ok(same.every(item => item === endpoints[0])); assert.equal(sessions.length, 2);
  network.setModel(direct);
  const updated = await network.configuration();
  assert.deepEqual(updated.default, configuration.default); assert.deepEqual(updated.plugins.custom, configuration.plugins.custom);
  assert.equal(updated.plugins.model.mode, 'none');
});

test('system resolver selects per destination, direct bypass stays direct, dead proxy never falls back silently', async t => {
  const upstream = await proxy(t, 'system'), resolved = [];
  const local = createServer((_req, res) => res.end('direct-origin'));
  const url = await listen(local, t);
  const { network, pool } = await setup(t, async target => { resolved.push(target); return target.startsWith(url) ? 'DIRECT' : `PROXY ${new URL(upstream.url).host}`; });
  const endpoint = await network.endpoint(config('system')), send = pool.forEndpoint(endpoint);
  assert.equal(await (await send(url)).text(), 'direct-origin');
  assert.equal((await (await send('http://fixture.invalid/')).json()).tag, 'system');
  assert.equal(resolved.length, 2);
  const broken = await network.endpoint(config('manual', { httpProxy: 'http://127.0.0.1:1' }));
  assert.equal((await pool.forEndpoint(broken)('http://fixture.invalid')).status, 502);
  const bypass = await network.endpoint(config('manual', { httpProxy: 'http://127.0.0.1:1', noProxy: '127.0.0.1' }));
  assert.equal(await (await pool.forEndpoint(bypass)(url)).text(), 'direct-origin');
});

test('stdio receives explicit proxy environment, and direct clears mixed-case inherited values without changing parent', async t => {
  const { network, file } = await setup(t);
  await writeFile(file, JSON.stringify({ proxy: config('system'), plugins: [{ id: 'direct', config: { proxy: direct } }] }));
  const routed = await network.environment(), env = await network.environment('direct');
  assert.ok(routed.HTTPS_PROXY.startsWith('http://cardbush:')); assert.equal(env.HTTPS_PROXY, ''); assert.equal(env.NO_PROXY, '*');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({upper:process.env.HTTPS_PROXY,lower:process.env.https_proxy,bypass:process.env.NO_PROXY,custom:process.env.KEEP_ME}))'],
    { env: { ...process.env, HTTPS_PROXY: 'http://unwanted:8', https_proxy: 'http://unwanted:9', KEEP_ME: 'retained', ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); const [code] = await once(child, 'exit');
  assert.equal(code, 0); assert.deepEqual(JSON.parse(output), { upper: '', lower: '', bypass: '*', custom: 'retained' });
  assert.deepEqual(pluginProxyEnvironment(''), env);
});

test('streaming responses deliver before completion and cancellation closes upstream; unsigned requests cannot use the gateway', async t => {
  let closed = false;
  const origin = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n');
    const timer = setInterval(() => res.write('data: next\n\n'), 50);
    res.once('close', () => { clearInterval(timer); closed = true; });
  });
  const url = await listen(origin, t), { network, pool } = await setup(t);
  const endpoint = await network.endpoint(config('system'));
  const unsigned = new URL(endpoint); unsigned.username = ''; unsigned.password = '';
  const probe = request(unsigned, { agent: false }); probe.end();
  const [unauthorized] = await once(probe, 'response'); unauthorized.resume();
  assert.equal(unauthorized.statusCode, 407);
  const abort = new AbortController(), response = await pool.forEndpoint(endpoint)(url, { signal: abort.signal });
  const reader = response.body.getReader(), first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  abort.abort(); await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !closed; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(closed, true);
});

test('direct CONNECT supports local TCP without rewriting bytes', async t => {
  const echo = createTcpServer(socket => socket.pipe(socket)); await listen(echo, t);
  const { network } = await setup(t);
  assert.equal(await tunnel(await network.endpoint(networkProxySchema.parse({ mode: 'system' })), `127.0.0.1:${echo.address().port}`), 'echo');
});

test('manual HTTP proxy credentials remain proxy-only and SOCKS5h resolves names remotely', async t => {
  const upstream = await proxy(t, 'authenticated');
  const { network, pool } = await setup(t);
  const address = new URL(upstream.url); address.username = 'fixture'; address.password = 'password';
  const endpoint = await network.endpoint(config('manual', { httpProxy: address.href, httpsProxy: address.href }));
  assert.equal((await (await pool.forEndpoint(endpoint)('http://fixture.invalid')).json()).tag, 'authenticated');
  assert.equal(upstream.seen[0].headers['proxy-authorization'], `Basic ${Buffer.from('fixture:password').toString('base64')}`);
  await tunnel(endpoint, 'fixture.invalid:443');
  assert.equal(upstream.seen[1].headers.authorization, undefined);
  assert.equal(upstream.seen[1].headers['proxy-authorization'], upstream.seen[0].headers['proxy-authorization']);
  const destinations = [];
  const socks = createTcpServer(socket => {
    let phase = 0, buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (phase === 0) { if (buffer.length < 2 + buffer[1]) return; buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 0])); phase = 1; }
      if (phase === 1) {
        if (buffer.length < 5) return;
        assert.equal(buffer[3], 3, 'destination must reach SOCKS as a domain without local DNS');
        const size = 7 + buffer[4]; if (buffer.length < size) return;
        destinations.push(buffer.subarray(5, 5 + buffer[4]).toString()); buffer = buffer.subarray(size);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); phase = 2;
      }
      if (phase === 2 && buffer.includes('\r\n\r\n')) { socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nsocks'); phase = 3; }
    });
  });
  const socksUrl = (await listen(socks, t)).replace('http:', 'socks5h:');
  const routed = await network.endpoint(config('manual', { httpProxy: socksUrl }));
  assert.equal(await (await pool.forEndpoint(routed)('http://remote-name.invalid')).text(), 'socks');
  assert.deepEqual(destinations, ['remote-name.invalid']);
});

test('standalone MCP proxy stays in its own configuration and takes precedence over plugin defaults', async t => {
  const { network, file, root } = await setup(t);
  network.setModel(config('system'));
  await writeFile(file, JSON.stringify({ proxy: config('manual', { httpProxy: '127.0.0.1:8123' }), plugins: [{ id: 'same', config: { proxy: direct } }] }));
  const initial = { id: 'same', name: 'Same name', transport: 'stdio', command: 'fixture', env: { PRIVATE: 'preserved' } };
  const saved = mergeMcpServer(initial, { id: 'same', proxy: config('model') });
  assert.deepEqual(saved.env, initial.env);
  await writeFile(join(root, 'mcp-servers.json'), JSON.stringify({ servers: [saved] }));
  const resolved = await network.configuration();
  assert.equal(resolved.default.mode, 'manual'); assert.equal(resolved.plugins.same.mode, 'none'); assert.equal(resolved.servers.same.mode, 'system');
  const reset = mergeMcpServer(saved, { id: 'same', proxy: null }); assert.equal(reset.proxy, undefined);
  await writeFile(join(root, 'mcp-servers.json'), JSON.stringify({ servers: [reset] }));
  assert.deepEqual((await network.configuration()).servers.same, resolved.default);
  assert.throws(() => mergeMcpServer(saved, { id: 'same', proxy: { mode: 'unsupported' } }));
});
