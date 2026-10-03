const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const electron = require('electron');

const parent = path.resolve(os.tmpdir());
if (typeof electron === 'string') {
  if (process.platform !== 'win32') { console.log('Native desktop browser regression requires Windows and Chrome.'); process.exit(0); }
  const root = fs.mkdtempSync(path.join(parent, 'cardbush-desktop-browser-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename, root], { env, stdio: 'inherit', windowsHide: true, timeout: 85_000 });
  assert.equal(path.dirname(path.resolve(root)).toLowerCase(), parent.toLowerCase());
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}

const { app } = electron;
const root = path.resolve(process.argv[2]);
assert.ok(root.startsWith(parent + path.sep + 'cardbush-desktop-browser-'));
fs.mkdirSync(path.join(root, 'electron-data')); app.setPath('userData', path.join(root, 'electron-data'));
app.on('window-all-closed', () => {});
let chrome, controller, server, requests = [], heartbeats = 0, launches = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, message); await delay(50); }
}
const watchdog = setTimeout(() => { console.error('Desktop browser regression timed out.'); chrome?.kill(); app.exit(1); }, 75_000);

async function run() {
  await app.whenReady();
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { McpDesktopHost } = await import('../dist-electron/mcpDesktopHost.js');
  server = require('node:http').createServer(async (request, response) => {
    if (request.url === '/alive') { heartbeats++; response.end('ok'); return; }
    if (request.url === '/page') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>CardBush browser lifetime regression</title><p>Isolated test page</p><script>setInterval(()=>fetch("/alive"),150)</script>'); return;
    }
    if (request.method !== 'POST' || !request.url.startsWith('/v1/')) { response.writeHead(404); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url.endsWith('/input_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":50}'); return; }
    requests.push(body);
    const number = requests.length;
    const terminalCommand = "$owned = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Write-Output ('ownedChild=' + $owned.Id); Start-Sleep -Seconds 1";
    const item = number === 1
      ? { type: 'function_call', id: 'fc_open', call_id: 'call_open', name: 'open_external_url', arguments: JSON.stringify({ url: pageUrl }), status: 'completed' }
      : number === 2 ? { type: 'function_call', id: 'fc_terminal', call_id: 'call_terminal', name: 'terminal_exec', arguments: JSON.stringify({ command: terminalCommand, cwd: root, shell: 'powershell', yield_time_ms: 10000 }), status: 'completed' }
      : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Navigation requested.', annotations: [] }] };
    const result = { id: `resp_${number}`, object: 'response', model: 'fixture', created_at: 1, status: 'completed', store: false, output: [item] };
    const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      ...(number < 3 ? [{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, name: item.name, arguments: item.arguments }]
        : [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Navigation requested.' }]),
      { type: 'response.completed', response: result }];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [sequence_number, event] of events.entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/page`;
  const desktop = new McpDesktopHost({ path: path.join(root, 'unused-vault'), changed() {},
    encrypt() { throw Error('not used'); }, decrypt() { throw Error('not used'); },
    // Replace only the OS default-browser selection with a real isolated Chrome.
    // The production desktop RPC, tool executor, model loop and resource guard stay real.
    openUrl: async url => {
      launches++; assert.equal(url, pageUrl);
      chrome = spawn(path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'), [
        '--headless=new', '--no-first-run', '--disable-extensions', '--disable-background-networking',
        '--remote-debugging-port=0', `--user-data-dir=${path.join(root, 'chrome-profile')}`, url,
      ], { windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { chrome.once('spawn', resolve); chrome.once('error', reject); });
    },
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
  const appsConfig = path.join(root, 'apps.json');
  fs.writeFileSync(appsConfig, JSON.stringify({ protocol: 'cardbush.apps_config.v1', revision: 1, serviceEnabled: false, plugins: [] }));
  const options = { modulePath: path.resolve('dist-electron/runtimeHostWorker.mjs'), startupTimeoutMs: 25000,
    onStderr: text => process.stderr.write(text),
    env: { ...env, CARDBUSH_RUNTIME_STATE_ROOT: path.join(root, 'runtime'), CARDBUSH_APPS_CONFIG_PATH: appsConfig,
      CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]', CARDBUSH_MCP_DESKTOP_BRIDGE: '1' },
    onMcpHostRequest: (operation, payload, signal) => desktop.handle(operation, payload, signal),
  };
  controller = new RuntimeUtilityProcessController(options);
  const command = async (kind, payload = {}) => {
    const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
  };
  const tools = (await command('runtime.get_tool_catalog')).filter(tool => ['open_external_url', 'terminal_exec'].includes(tool.name));
  assert.equal(tools.length, 2, 'opening webpages must remain available without the Browser Use plugin');
  const binding = await command('runtime.upsert_provider_binding', { protocol: 'bush.provider_binding_config.v1', bindingId: 'fixture-model',
    adapter: 'openai_responses', apiKey: 'local-fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 10000 });
  const turn = await command('runtime.run_model_turn', { protocol: 'bush.model_request.v1', requestId: 'request-browser', sessionId: 'session-browser',
    turnId: 'turn-browser', model: 'fixture', providerBinding: binding.binding, permissionMode: 'all_free',
    messages: [{ role: 'user', content: 'Open the fixture webpage and leave it running.' }], tools });
  assert.equal(turn.payload.status, 'completed', JSON.stringify(turn));
  assert.equal(launches, 1); assert.equal(requests.length, 3);
  const receipt = requests[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'call_open');
  assert.match(receipt.output, /dispatched/); assert.match(receipt.output, /"pageLoadVerified":false/);
  const terminalReceipt = requests[2].input.find(item => item.type === 'function_call_output' && item.call_id === 'call_terminal');
  const ownedPid = Number(terminalReceipt.output.match(/ownedChild=(\d+)/)?.[1]);
  assert.ok(ownedPid > 0, terminalReceipt.output);
  await until(() => { try { process.kill(ownedPid, 0); return false; } catch { return true; } }, 'terminal descendants still need cleanup');
  await until(() => heartbeats >= 3, 'real Chrome must load the page');
  controller.stop();
  const before = heartbeats;
  await until(() => heartbeats >= before + 8, 'browser must survive turn completion, terminal cleanup and Runtime shutdown');
  assert.equal(chrome.exitCode, null);
  for (const extra of [{ CARDBUSH_MCP_DESKTOP_BRIDGE: '' }, { CARDBUSH_SERVICE_ID: 'fixture-service' }]) {
    controller = new RuntimeUtilityProcessController({ ...options, env: { ...options.env, ...extra } });
    assert.equal((await command('runtime.get_tool_catalog')).some(tool => tool.name === 'open_external_url'), false, 'non-desktop hosts cannot open the local browser');
    controller.stop();
  }
  console.log('Passed: live Runtime tool discovery and model turn, desktop RPC, real isolated Chrome page survival, terminal child cleanup, worker shutdown, and remote/service exclusion. OS default-browser selection was replaced with an isolated Chrome launcher.');
}

async function cleanup() {
  controller?.stop();
  if (chrome && chrome.exitCode === null) {
    try {
      const [port, endpoint] = fs.readFileSync(path.join(root, 'chrome-profile/DevToolsActivePort'), 'utf8').trim().split('\n');
      const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await until(() => chrome.exitCode !== null, 'owned test browser must close'); socket.close();
    } catch { chrome.kill(); }
  }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  clearTimeout(watchdog);
}
run().then(async () => { await cleanup(); app.exit(0); }, async error => { console.error(error); await cleanup(); app.exit(1); });
