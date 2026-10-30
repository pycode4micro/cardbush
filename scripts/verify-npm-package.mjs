import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const { values } = parseArgs({ options: { tarball: { type: 'string' }, name: { type: 'string', default: 'cardbush' } } });
if (!values.tarball || !process.env.npm_execpath) throw new Error('Usage: npm run verify:npm-package -- --tarball /absolute/path/cardbush.tgz');
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(values.name)) throw new Error('Invalid package name.');
const tarball = resolve(values.tarball);
await access(tarball);
// Outside the checkout: Node must not accidentally find development dependencies.
const temporary = await mkdtemp(join(tmpdir(), 'cardbush-npm-verify-'));
assert.ok(!temporary.startsWith(resolve(import.meta.dirname, '..') + sep));
const prefix = join(temporary, 'installation with spaces');
const workspace = join(temporary, 'workspace');
const serviceRoot = join(temporary, 'service');
const localRoot = join(temporary, 'local-agent');
const profile = join(temporary, 'no-app-profile');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CARDBUSH_|NODE_PATH$|NODE_OPTIONS$|ELECTRON_)/i.test(key)));
Object.assign(env, { CARDBUSH_CLI_DATA_DIR: localRoot, CARDBUSH_CLI_PROFILE_DIR: profile,
  CARDBUSH_CLI_CONFIG: join(temporary, 'cli.json'), CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' });
await mkdir(workspace);
let service, client, serviceLog = '', succeeded = false, calls = 0;
let delegated = false;
const workerCalls = [];
const answer = 'NPM_AGENT_CLI_SMOKE_OK';
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url.endsWith('/input_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 })); return;
    }
    calls++;
    if (body.model === 'smoke-worker') workerCalls.push(body);
    const dispatch = body.model === 'smoke-parent' && !delegated && JSON.stringify(body.input).includes('npm registered worker conversation');
    if (dispatch) delegated = true;
    const item = dispatch
      ? { id: `function-${calls}`, call_id: `call-${calls}`, type: 'function_call', name: 'subagent', status: 'completed',
        arguments: JSON.stringify({ agent_id: 'npm-smoke-worker', prompt: 'Return NPM_AGENT_CLI_SMOKE_OK from the installed worker.' }) }
      : { id: `message-${calls}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const result = { id: `response-${calls}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: 'response.created', response: result });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit(dispatch
      ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
      : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...result, status: 'completed', output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
    response.end();
  } catch { response.writeHead(500).end(); }
});
async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await delay(100); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
const options = { cwd: workspace, env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
try {
  console.log('Installing the tarball outside the checkout (no global user installation is changed)...');
  const installation = await run(process.execPath, [process.env.npm_execpath, 'install', '--global', '--prefix', prefix,
    '--ignore-scripts', '--no-audit', '--no-fund', tarball], { ...options, timeout: 300_000 });
  await writeFile(join(temporary, 'installation.log'), installation.stdout + installation.stderr);
  const installed = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', values.name);
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined); assert.equal(manifest.workspaces, undefined);
  assert.ok(manifest.bundleDependencies.length > 0);
  for (const name of manifest.bundleDependencies) await access(join(installed, 'node_modules', name, 'package.json'));
  await assert.rejects(access(join(installed, 'node_modules/electron')), { code: 'ENOENT' });
  const cli = args => run(process.execPath, [join(installed, 'bin/cardbush.mjs'), ...args], options);
  const shim = process.platform === 'win32'
    ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'cardbush.cmd --version'], { ...options, cwd: prefix })
    : await run(join(prefix, 'bin/cardbush'), ['--version'], options);
  assert.equal(shim.stdout.trim(), `CardBush ${manifest.version}`);
  assert.match((await cli(['--help'])).stdout, /cardbush serve --data-dir/);
  assert.match((await cli(['serve', '--help'])).stdout, /CardBush Agent service/);
  assert.match((await run(process.execPath, [join(installed, 'bin/cardbush-agent.mjs'), '--help'], options)).stdout, /CardBush Agent service/);
  assert.equal((await run(process.execPath, [join(installed, 'bin/cardbush-agent.mjs'), '--version'], options)).stdout.trim(), shim.stdout.trim());
  console.log('Installed entry points and bundled workspaces passed. Checking native assets...');
  const moduleUrl = path => pathToFileURL(join(installed, path)).href;
  const probe = join(workspace, 'probe.mjs');
  await writeFile(probe, `import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { createRequire } from 'node:module';
    import { verifyProcessResourceHost } from ${JSON.stringify(moduleUrl('node_modules/@cardbush/bush-runtime/dist/processes.js'))};
    import { trustedSearchExecutable } from ${JSON.stringify(moduleUrl('node_modules/@cardbush/bush-runtime/dist/workspaceSearch.js'))};
    const require = createRequire(${JSON.stringify(moduleUrl('package.json'))});
    const host = await verifyProcessResourceHost();
    if (process.platform === 'win32') assert.ok(host.startsWith(${JSON.stringify(installed + sep)}));
    const rg = await trustedSearchExecutable(process.cwd(), process.cwd());
    assert.ok(rg?.startsWith(${JSON.stringify(installed + sep)}), 'ripgrep must resolve from the installed release');
    assert.match(execFileSync(rg, ['--version'], { encoding: 'utf8', windowsHide: true }), /^ripgrep /);
    const sharp = require('sharp');
    assert.ok((await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ffffff' } }).png().toBuffer()).length);
    assert.ok(require('@napi-rs/canvas').createCanvas(4, 4).toBuffer('image/png').length);
    console.log('INSTALLED_NATIVE_ASSETS_OK');
  `);
  assert.match((await run(process.execPath, [probe], options)).stdout, /INSTALLED_NATIVE_ASSETS_OK/);
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  await mkdir(join(serviceRoot, 'config'), { recursive: true });
  await writeFile(join(serviceRoot, 'config/apps.json'), JSON.stringify({ protocol: 'cardbush.apps.config.v1', revision: 1,
    serviceEnabled: true, plugins: ['computer-use', 'chrome'].map(id => ({ id, installed: true, enabled: true,
      config: id === 'computer-use' ? { screenshotDirectory: '', allowOpenApp: true, allowWindowClose: true, yieldToUser: true, restorePointer: true } : {} })) }));
  service = spawn(process.execPath, [join(installed, 'bin/cardbush-agent.mjs'), '--data-dir', serviceRoot, '--port', '0'],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', data => { serviceLog += data; }); service.stderr.on('data', data => { serviceLog += data; });
  service.on('error', error => { serviceLog += error.message; });
  await until(() => {
    if (service.exitCode !== null) throw new Error(`Installed service exited: ${serviceLog}`);
    return /listening on http:\/\/127\.0\.0\.1:\d+/.test(serviceLog);
  }, 'installed service startup');
  const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serviceLog)[1] + '/';
  const tokenFile = join(serviceRoot, 'access-token');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  assert.equal((await fetch(new URL('api/agent/v1/info', url))).status, 401);
  const { AgentHttpClient } = await import(moduleUrl('dist-electron/agentHttpClient.mjs'));
  client = new AgentHttpClient(url, token); const info = await client.info();
  assert.equal(info.capabilities.tools, true);
  await until(async () => {
    const servers = (await client.call('mcp.list', {})).runtime?.servers ?? [];
    return ['cardbush_apps', 'browser_use'].every(id => servers.some(server => server.id === id && server.health === 'ready' && server.tools.length > 0));
  }, 'installed browser and computer-use MCP discovery');
  await client.call('product.command', { kind: 'models.update', config: { defaultModelId: 'smoke', models: [
    { id: 'smoke', provider: 'openai', model: 'smoke-worker', apiKey: 'local-fixture-only', baseURL: `http://127.0.0.1:${model.address().port}/v1` },
  ] } });
  const config = join(profile, 'product-host/config'); await mkdir(config, { recursive: true });
  const models = JSON.parse(await readFile(join(serviceRoot, 'config/models.json'), 'utf8'));
  models.models[0].model = 'smoke-parent';
  await writeFile(join(config, 'models.json'), JSON.stringify(models));
  console.log('Registering the installed service through the installed worker CLI...');
  const added = await cli(['worker', 'add', '--name', 'Npm smoke worker', '--url', url, '--token-file', tokenFile]);
  const connectionId = added.stdout.trim().split(/\r?\n/)[0].split('\t')[0];
  assert.match(connectionId, /^[a-f0-9-]{36}$/);
  assert.match((await cli(['worker', 'verify', connectionId])).stdout, new RegExp(info.id));
  assert.ok((await cli(['worker', 'list'])).stdout.includes(connectionId));
  const registration = join(temporary, 'register-worker.mjs');
  await writeFile(registration, `
    import { openLocalChatClient } from ${JSON.stringify(moduleUrl('dist-electron/agentLocalChat.mjs'))};
    const client = await openLocalChatClient();
    try {
      await client.call('runtime.command', { kind: 'runtime.agent_registry', payload: {
        action: 'save', expected_revision: 0, definition: { id: 'npm-smoke-worker', name: 'Npm smoke worker',
          system_prompt: 'Complete the assigned deployment verification task.',
          remote: { connection_id: ${JSON.stringify(connectionId)}, agent_id: ${JSON.stringify(info.id)} } }
      } });
    } finally { await client.close(); }
  `);
  await run(process.execPath, [registration], options);
  assert.match((await cli(['--prompt', 'npm registered worker conversation'])).stdout, new RegExp(answer));
  assert.equal(delegated, true, 'the parent must dispatch the registered role');
  assert.equal(workerCalls.length, 1, 'the service must execute the delegated task exactly once');
  const jobs = await client.call('chat.jobs', {});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');
  assert.ok(jobs[0].delegation?.parentSessionId, 'the service job must belong to a parent');
  const child = await client.call('sessions.get', { sessionId: jobs[0].sessionId });
  assert.equal(child.metadata.agentRole, 'child');
  await client.call('runtime.command', { kind: 'runtime.collect_cache', payload: {} });
  const retainedChild = await client.call('sessions.get', { sessionId: jobs[0].sessionId });
  assert.equal(retainedChild?.turns.length, child.turns.length, 'worker history must survive collection without a local parent');
  console.log('Testing a separate local CLI runtime with an isolated profile and no App authorization...');
  assert.match((await cli(['--local', '--prompt', 'npm local conversation'])).stdout, new RegExp(answer));
  assert.match((await cli(['--sessions'])).stdout, /session-/);
  assert.ok(calls >= 2, 'both service and local CLI must reach the mock provider');
  assert.equal((await client.info()).id, info.id, 'exiting the CLI must not stop the service');
  const state = JSON.parse(await readFile(join(localRoot, 'agent.json'), 'utf8'));
  assert.ok(state.jobs.some(job => job.status === 'completed'));
  const report = { tarball, version: manifest.version, platform: process.platform, installedOutsideCheckout: true,
    bundledWorkspaces: manifest.bundleDependencies.length, nativeAssets: 'passed', registeredWorkerDelegation: 'passed', workerHistoryRetention: 'passed',
    bundledMcpDiscovery: 'passed', independentLocalChat: 'passed', provider: 'local mock only', modelCalls: calls };
  await writeFile(join(dirname(tarball), 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); succeeded = true;
} finally {
  client?.close();
  if (service && service.exitCode === null && service.signalCode === null) {
    const closed = once(service, 'exit'); service.kill(); await closed;
  }
  if (model.listening) { model.closeAllConnections(); await new Promise(done => model.close(done)); }
  await until(async () => {
    try { await access(join(localRoot, 'agent.lock')); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }, 'local runtime idle shutdown').catch(error => { succeeded = false; process.exitCode = 1; console.error(error.message); });
  if (succeeded) {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(temporary.includes('cardbush-npm-verify-'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } else console.error(`Verification files retained at: ${temporary}`);
}
