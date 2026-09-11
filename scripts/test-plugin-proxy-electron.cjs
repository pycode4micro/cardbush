const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createServer, request } = require('node:http');
const { createServer: createHttpsServer } = require('node:https');
const { X509Certificate } = require('node:crypto');
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
app.on('window-all-closed', () => {});
app.setPath('userData', join(root, 'profile')); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Proxy Electron fixture timed out'); app.exit(1); }, 25_000);
void app.whenReady().then(async () => {
  const { PluginNetwork } = await import('../dist-electron/pluginNetwork.mjs');
  const { PluginUiNetwork } = await import('../dist-electron/pluginUiNetwork.mjs');
  const { ProxyFetchPool } = await import('../dist-electron/proxyFetch.mjs');
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { randomUUID } = require('node:crypto');
  const sockets = new Set(), servers = [], sessions = [];
  const listen = async server => { servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
  const resource = name => (req, res) => { assert.equal(req.headers['proxy-authorization'], undefined, 'local route credentials never reach the resource server'); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store'); if (req.url.includes('/script')) { res.setHeader('Content-Type', 'application/javascript'); res.end(`window.fixtureAsset=${JSON.stringify(name)}`); } else res.end(name); };
  const a = await listen(createServer(resource('proxy-A'))), b = await listen(createServer(resource('proxy-B')));
  const pac = await listen(createServer((_req, res) => { res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig'); res.end(`function FindProxyForURL(url, host) { return host === 'one.invalid' ? 'PROXY ${new URL(a).host}' : 'PROXY ${new URL(b).host}'; }`); }));
  const file = join(root, 'apps.json'), network = new PluginNetwork(file, partition => { const item = session.fromPartition(partition); sessions.push(item); return item; }), pool = new ProxyFetchPool();
  let controller, uiNetwork, window;
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

    // Real sandboxed iframe resources use the same global plugin route as MCP,
    // without changing model networking or rewriting request URLs/CSP.
    const uiSession = session.fromPartition('fixture-ui');
    uiNetwork = new PluginUiNetwork(network, uiSession, app);
    const config = proxy => writeFileSync(file, JSON.stringify({ proxy, plugins: [] }));
    config({ mode: 'manual', httpProxy: a, httpsProxy: a }); await uiNetwork.refresh();
    window = new electron.BrowserWindow({ show: false, webPreferences: { session: uiSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const html = '<script src="http://one.invalid/script"></script><script>fetch("http://one.invalid/data").then(r=>r.text()).then(text=>parent.postMessage({fixture: text, asset: window.fixtureAsset},"*"))</script>';
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<script>window.result=null;addEventListener('message',event=>window.result=event.data)</script><iframe sandbox="allow-scripts" srcdoc="${html.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`));
    const until = async script => { const end = Date.now() + 4000; while (!await window.webContents.executeJavaScript(script)) { if (Date.now() > end) throw Error('Iframe proxy timed out'); await new Promise(done => setTimeout(done, 25)); } };
    await until('window.result?.fixture');
    assert.deepEqual(await window.webContents.executeJavaScript('window.result'), { fixture: 'proxy-A', asset: 'proxy-A' });
    config({ mode: 'manual', httpProxy: b, httpsProxy: b }); await uiNetwork.refresh();
    const fetchInFrame = () => window.webContents.mainFrame.frames[0].executeJavaScript('fetch("http://one.invalid/data",{cache:"no-store"}).then(r=>r.text())');
    assert.equal(await fetchInFrame(), 'proxy-B', 'a saved proxy applies to requests in an existing iframe');
    assert.equal(await (await modelSession.fetch('http://one.invalid')).text(), 'proxy-B');
    config({ mode: 'system' }); await uiNetwork.refresh();
    assert.equal(await fetchInFrame(), 'proxy-A', 'system PAC applies to iframe resources');
    assert.equal(await window.webContents.mainFrame.frames[0].executeJavaScript('fetch("http://two.invalid/data").then(r=>r.text())'), 'proxy-B', 'PAC routing remains per destination');
    network.setModel({ mode: 'manual', httpProxy: a, httpsProxy: a }); config({ mode: 'model' }); await uiNetwork.refresh();
    assert.equal(await fetchInFrame(), 'proxy-A', 'inherit follows the model proxy');
    config({ mode: 'manual', httpProxy: b, httpsProxy: b }); await Promise.all([uiNetwork.refresh(), uiNetwork.refresh()]);
    assert.equal(await fetchInFrame(), 'proxy-B');
    config({ mode: 'none' }); await uiNetwork.refresh();
    assert.equal(await uiSession.resolveProxy('http://one.invalid'), 'DIRECT');
    assert.equal(await modelSession.resolveProxy('http://one.invalid'), `PROXY ${new URL(b).host}`, 'UI route changes leave the model session unchanged');
    // Use a fresh Chromium session: earlier HTTP requests must not pre-warm the
    // proxy auth cache and conceal a missing HTTPS CONNECT challenge.
    const tlsSession = session.fromPartition('fixture-ui-https');
    const httpsFailures = [];
    tlsSession.webRequest.onErrorOccurred(details => httpsFailures.push({ error: details.error, type: details.resourceType }));
    window.destroy(); uiNetwork.dispose();
    const cert = readFileSync(join(__dirname, 'fixtures/plugin-proxy-tls/cert.pem'));
    const key = readFileSync(join(__dirname, 'fixtures/plugin-proxy-tls/key.pem'));
    const fingerprint = new X509Certificate(cert).fingerprint256;
    tlsSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
    const secureResource = (await listen(createHttpsServer({ key, cert }, resource('https-resource')))).replace('http:', 'https:');
    uiNetwork = new PluginUiNetwork(network, tlsSession, app);
    config({ mode: 'manual', httpProxy: a, httpsProxy: b, noProxy: '127.0.0.1' }); await uiNetwork.refresh();
    let challenges = 0;
    const observeLogin = (_event, contents, _details, auth) => { if (contents?.session === tlsSession && auth.isProxy) challenges++; };
    app.on('login', observeLogin);
    try {
      window = new electron.BrowserWindow({ show: false, webPreferences: { session: tlsSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const httpsHtml = `<script src="${secureResource}/script"></script><script>fetch("${secureResource}/data").then(r=>r.text()).then(text=>parent.postMessage({fixture:text,asset:window.fixtureAsset},"*"))</script>`;
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<script>window.result=null;addEventListener('message',event=>window.result=event.data)</script><iframe sandbox="allow-scripts" srcdoc="${httpsHtml.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`));
      try { await until('window.result?.fixture'); }
      catch (error) { throw new Error(`${error.message}; challenges=${challenges}; ${JSON.stringify(httpsFailures)}`); }
      assert.deepEqual(await window.webContents.executeJavaScript('window.result'), { fixture: 'https-resource', asset: 'https-resource' });
      assert.ok(challenges > 0, 'a fresh HTTPS iframe receives and completes the local proxy challenge');
    } finally { app.removeListener('login', observeLogin); }
    window.destroy(); window = undefined; uiNetwork.dispose(); uiNetwork = undefined;
    console.log('Plugin iframe proxy passed: native HTTP/HTTPS script/fetch, fresh CONNECT authentication, persisted route changes, model inheritance and session isolation.');

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
    window?.destroy(); uiNetwork?.dispose();
    await controller?.stop(); await pool.close(); await network.close();
    for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); clearTimeout(deadline);
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
