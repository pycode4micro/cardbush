const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const electron = require('electron');
const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'cardbush-openai-worker-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(electron, [__filename, root], { env, stdio: 'inherit', windowsHide: true, timeout: 45_000 });
  assert.ok(root.startsWith(parent + sep + 'cardbush-openai-worker-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = electron, root = resolve(process.argv[2]);
assert.ok(root.startsWith(parent + sep + 'cardbush-openai-worker-'));
mkdirSync(join(root, 'profile')); app.setPath('userData', join(root, 'profile'));
const deadline = setTimeout(() => { console.error('OpenAI worker fixture timed out'); app.exit(1); }, 40_000);
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

async function run() {
  await app.whenReady(); assert.equal(safeStorage.isEncryptionAvailable(), true);
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { McpDesktopHost } = await import('../dist-electron/mcpDesktopHost.js');
  const { OpenAiAccount, OPENAI_ACCOUNT_CREDENTIAL_KEY } = await import('../dist-electron/openAiAccount.mjs');
  const { AccountManager, openAiAccountSummary } = await import('../dist-electron/accountManager.mjs');
  const { OPENAI_HOSTED_PROTOCOL } = await import('@cardbush/bush-protocol');
  const wrapper = join(root, 'fixture-worker.mjs'), observations = join(root, 'requests.txt');
  // Intercept only inside this isolated test worker; production still uses the fixed HTTPS endpoint.
  writeFileSync(wrapper, `import assert from 'node:assert/strict'; import { appendFileSync } from 'node:fs';
    import { ProxyFetchPool } from ${JSON.stringify(pathToFileURL(resolve('dist-electron/proxyFetch.mjs')).href)};
    ProxyFetchPool.prototype.forEndpoint = () => async (url, init) => {
      assert.equal(String(url), ${JSON.stringify(OPENAI_HOSTED_PROTOCOL.mcpEndpoint)});
      const headers=new Headers(init.headers); assert.match(headers.get('authorization'), /^Bearer PRIVATE_WORKER_/);
      assert.equal(init.redirect,'error'); assert.equal(init.credentials,'omit');
      if(init.method==='GET')return new Response(null,{status:405});
      const message=JSON.parse(init.body); appendFileSync(${JSON.stringify(observations)}, message.method+'\\n');
      if(!('id' in message))return new Response(null,{status:202});
      const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
        {tools:['expected-app','another-app'].map(id=>({name:id==='expected-app'?'read_profile':'unrelated',inputSchema:{type:'object',properties:{}},_meta:{connector_id:id}}))};
      return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'Content-Type':'application/json'}});
    }; await import(${JSON.stringify(pathToFileURL(resolve('dist-electron/runtimeHostWorker.mjs')).href)});`);
  let browserOpens = 0, tokenRequests = 0, loginNumber = 0;
  const vault = join(root, 'mcp-oauth.bin'), signal = new AbortController().signal;
  const desktop = new McpDesktopHost({ path: vault, encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes),
    openUrl: async () => { throw Error('The fixture never opens a real browser'); }, changed() {} });
  const options = {
    read: () => desktop.handle('credentials.read', { key: OPENAI_ACCOUNT_CREDENTIAL_KEY }, signal),
    write: value => desktop.handle('credentials.write', { key: OPENAI_ACCOUNT_CREDENTIAL_KEY, value }, signal), changed() {},
    openUrl: async () => { browserOpens++; }, startLogin: async () => ({ authorizationUrl: 'https://fixture.invalid', redirectUri: 'http://localhost:0',
      result: Promise.resolve({ access_token: 'PRIVATE_WORKER_' + ++loginNumber, refresh_token: 'PRIVATE_REFRESH', expires_in: 3600 }), close: async () => {} }),
  };
  let account = new OpenAiAccount(options);
  const accounts = new AccountManager([{ providerId: 'openai', list: async () => [openAiAccountSummary(await account.status())],
    action: async (_id, action) => { if (action === 'login') await account.login(); else if (action === 'logout') await account.logout(); else if (action === 'cancel_login') account.cancelLogin(); },
  }]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
  writeFileSync(join(root, 'apps.json'), JSON.stringify({ serviceEnabled: false, plugins: [] }));
  const controller = new RuntimeUtilityProcessController({ modulePath: wrapper, env: { ...env, CARDBUSH_RUNTIME_STATE_ROOT: join(root, 'runtime'),
    CARDBUSH_APPS_CONFIG_PATH: join(root, 'apps.json'), CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]', CARDBUSH_MCP_DESKTOP_BRIDGE: '1' },
    onMcpHostRequest: (operation, payload, signal) => {
      if (operation === 'network.configuration') return Promise.resolve({ default: { mode: 'none', httpProxy: '', httpsProxy: '', noProxy: '' }, plugins: {} });
      if (operation === 'network.route') return Promise.resolve('');
      if (operation === 'openai.access-token') { tokenRequests++; return account.access({ ...payload, signal }); }
      return desktop.handle(operation, payload, signal);
    } });
  const command = async (kind, payload = {}) => {
    const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } });
    assert.equal(response.ok, true, JSON.stringify(response)); assert.doesNotMatch(JSON.stringify(response), /PRIVATE_WORKER_|PRIVATE_REFRESH/);
    let result = response.result;
    const until = Date.now() + 8000;
    while (result?.applicationState === 'pending') {
      assert.ok(Date.now() < until, 'Hosted MCP connection should settle');
      await new Promise(resolve => setTimeout(resolve, 20));
      const state = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind: 'runtime.get_mcp_snapshot', payload: {} } });
      assert.equal(state.ok, true, JSON.stringify(state)); result = state.result;
    }
    return result;
  };
  const snapshot = { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'openai-fixture', revision: 1, servers: [{ id: 'hosted', versionMode: 'legacy',
    transport: { kind: 'streamable_http', url: OPENAI_HOSTED_PROTOCOL.mcpEndpoint, auth: 'openai', openaiAppId: 'expected-app' } }] };
  try {
    assert.equal((await command('runtime.apply_mcp_snapshot', snapshot)).servers[0].health, 'auth_required');
    assert.equal(browserOpens, 0); assert.ok(tokenRequests > 0);
    await accounts.action({ providerId: 'openai', accountId: 'openai:default', action: 'login' });
    assert.equal((await accounts.snapshot()).accounts[0].state, 'signed_in');
    assert.doesNotMatch(JSON.stringify(await accounts.snapshot()), /PRIVATE_WORKER_|PRIVATE_REFRESH/);
    assert.equal((await command('runtime.openai_account_changed')).servers[0].health, 'ready');
    const tools = await command('runtime.get_tool_catalog');
    assert.ok(tools.some(tool => tool.name === 'mcp__hosted__read_profile'));
    assert.ok(!tools.some(tool => tool.name === 'mcp__hosted__unrelated'));
    assert.doesNotMatch(readFileSync(vault).toString(), /PRIVATE_WORKER_|PRIVATE_REFRESH/);
    const before = readFileSync(observations, 'utf8').split('\n').filter(value => value === 'initialize').length;
    await account.login(); await command('runtime.openai_account_changed');
    assert.equal(readFileSync(observations, 'utf8').split('\n').filter(value => value === 'initialize').length, before + 1, 'account replacement opens a new MCP session');
    controller.stop(); await account.close(); account = new OpenAiAccount(options);
    assert.equal((await accounts.snapshot()).accounts[0].state, 'signed_in', 'registry restores through the existing encrypted account adapter');
    assert.equal((await command('runtime.apply_mcp_snapshot', snapshot)).servers[0].health, 'ready');
    assert.equal(browserOpens, 2, 'worker/account restart restores encrypted credentials without another browser');
    await accounts.action({ providerId: 'openai', accountId: 'openai:default', action: 'logout' });
    assert.equal((await command('runtime.openai_account_changed')).servers[0].health, 'auth_required');
    assert.ok(!(await command('runtime.get_tool_catalog')).some(tool => tool.name === 'mcp__hosted__read_profile'));
    assert.doesNotMatch(safeStorage.decryptString(readFileSync(vault)), /PRIVATE_WORKER_|PRIVATE_REFRESH/);
    console.log('OpenAI Electron integration passed: private token bridge, real OS encryption, scoped catalog, account replacement, worker restore and logout.');
  } finally { controller.stop(); await account.close(); clearTimeout(deadline); }
}
