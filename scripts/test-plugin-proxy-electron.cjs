const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createServer, request } = require('node:http');
const { once } = require('node:events');
const electron = require('electron');
const parent = resolve('tmp');
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'plugin-proxy-electron-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawnSync(electron, [__filename, root], { env, stdio: 'inherit', windowsHide: true, timeout: 30_000 });
  assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error); process.exit(child.status ?? 1);
}
const { app, session } = electron, root = resolve(process.argv[2]);
app.setPath('userData', join(root, 'profile')); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Proxy Electron fixture timed out'); app.exit(1); }, 25_000);
void app.whenReady().then(async () => {
  const { PluginNetwork } = await import('../dist-electron/pluginNetwork.mjs');
  const { ProxyFetchPool } = await import('../dist-electron/proxyFetch.mjs');
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { randomUUID } = require('node:crypto');
  const sockets = new Set(), servers = [], sessions = [];
  const listen = async server => { servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
  const a = await listen(createServer((_req, res) => res.end('proxy-A'))), b = await listen(createServer((_req, res) => res.end('proxy-B')));
  const pac = await listen(createServer((_req, res) => { res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig'); res.end(`function FindProxyForURL(url, host) { return host === 'one.invalid' ? 'PROXY ${new URL(a).host}' : 'PROXY ${new URL(b).host}'; }`); }));
  const file = join(root, 'apps.json'), network = new PluginNetwork(file, partition => { const item = session.fromPartition(partition); sessions.push(item); return item; }), pool = new ProxyFetchPool();
  let controller;
  try {
    const manual = { mode: 'manual', httpProxy: a, httpsProxy: b, noProxy: 'localhost,.internal' };
    const endpoint = await network.endpoint(manual);
    assert.equal(await (await pool.forEndpoint(endpoint)('http://one.invalid')).text(), 'proxy-A');
    assert.equal(await sessions[0].resolveProxy('https://one.invalid'), `PROXY ${new URL(b).host}`);
    assert.equal(await sessions[0].resolveProxy('http://test.internal'), 'DIRECT');
    const modelSession = session.fromPartition('fixture-model'); await modelSession.setProxy({ mode: 'fixed_servers', proxyRules: `http=${b}` });
    assert.equal(await modelSession.resolveProxy('http://one.invalid'), `PROXY ${new URL(b).host}`, 'plugin route cannot change model session');
    const systemEndpoint = await network.endpoint({ mode: 'system' });
    await sessions[1].setProxy({ mode: 'pac_script', pacScript: pac });
    const result = await Promise.all(['one.invalid', 'two.invalid'].map(host => pool.forEndpoint(systemEndpoint)(`http://${host}`).then(res => res.text())));
    assert.deepEqual(result, ['proxy-A', 'proxy-B']);
    console.log('Electron proxy passed: isolated sessions, manual protocol rules, bypass and real PAC per destination.');

    // The actual utility process receives host-owned route configuration; no external MCP or model is called.
    const code = `let buffer=''; process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const request=JSON.parse(line);if(request.id===undefined)continue;const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'proxy-fixture',version:'1'}}:{tools:[{name:'env',description:JSON.stringify({upper:process.env.HTTPS_PROXY,lower:process.env.https_proxy,bypass:process.env.NO_PROXY,keep:process.env.KEEP_ME}),inputSchema:{type:'object',properties:{}}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');}});`;
    writeFileSync(file, JSON.stringify({ protocol: 'cardbush.apps_config.v1', revision: 1, serviceEnabled: false, proxy: manual, plugins: [] }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
    controller = new RuntimeUtilityProcessController({ modulePath: resolve('dist-electron/runtimeHostWorker.mjs'), env: { ...env, CARDBUSH_MCP_DESKTOP_BRIDGE: '1', CARDBUSH_RUNTIME_STATE_ROOT: join(root, 'runtime'), CARDBUSH_APPS_CONFIG_PATH: file, CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]' },
      onMcpHostRequest: async (operation, payload) => {
        if (operation === 'network.configuration') return network.configuration();
        if (operation === 'network.route') return network.endpoint(payload);
        throw Error(`Unexpected fixture operation: ${operation}`);
      } });
    await controller.start();
    const send = async (kind, payload) => { const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } }); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
    const snapshot = { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'proxy-fixture', revision: 1, servers: [{ id: 'stdio_fixture', transport: { kind: 'stdio', command: process.execPath, args: ['-e', code], env: { ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'retained', HTTPS_PROXY: 'http://unwanted:8' } } }] };
    await send('runtime.apply_mcp_snapshot', snapshot);
    let state;
    for (let i = 0; i < 100; i++) { state = await send('runtime.get_mcp_snapshot', {}); if (state.applicationState === 'applied') break; await new Promise(done => setTimeout(done, 25)); }
    assert.equal(state.servers[0].health, 'ready', JSON.stringify(state));
    assert.equal(state.servers[0].tools.length, 1);
    let tools = await send('runtime.get_tool_catalog', {});
    const inherited = JSON.parse(tools.find(tool => tool.name === 'mcp__stdio_fixture__env').description);
    assert.match(inherited.upper, /^http:\/\/cardbush:/); assert.equal(inherited.lower, inherited.upper); assert.equal(inherited.keep, 'retained');
    writeFileSync(file, JSON.stringify({ protocol: 'cardbush.apps_config.v1', revision: 2, serviceEnabled: false, proxy: { mode: 'none' }, plugins: [] }));
    await send('runtime.apply_mcp_snapshot', snapshot);
    for (let i = 0; i < 100; i++) { state = await send('runtime.get_mcp_snapshot', {}); if (state.applicationState === 'applied') break; await new Promise(done => setTimeout(done, 25)); }
    assert.equal(state.servers[0].health, 'ready');
    tools = await send('runtime.get_tool_catalog', {});
    assert.deepEqual(JSON.parse(tools.find(tool => tool.name === 'mcp__stdio_fixture__env').description), { upper: '', lower: '', bypass: '*', keep: 'retained' });
    assert.ok(state.revision > 1, 'effective network change creates a new MCP revision even when source MCP config is unchanged');
    console.log('Utility process proxy passed: stdio startup, private network bridge and async route replacement.');
  } finally {
    await controller?.stop(); await pool.close(); await network.close();
    for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); clearTimeout(deadline);
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
