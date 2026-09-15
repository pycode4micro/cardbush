const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, utilityProcess } = require('electron');
app.on('window-all-closed', () => {}); // Closing the fixture window must not quit before the utility test.

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-resource-electron-'));
app.setPath('userData', path.join(temporary, 'profile'));
const nativeDirectory = path.join(temporary, 'resources', 'process-guard');
fs.mkdirSync(nativeDirectory, { recursive: true });
const { fileName } = JSON.parse(fs.readFileSync(path.join(root, 'dist-native/process-guard/current.json'), 'utf8'));
const nativeHost = path.join(nativeDirectory, fileName);
fs.copyFileSync(path.join(root, 'dist-native/process-guard', fileName), nativeHost);
fs.writeFileSync(path.join(nativeDirectory, 'current.json'), JSON.stringify({ fileName }));
const workerPath = path.join(temporary, 'worker.mjs');
fs.writeFileSync(workerPath, `
import assert from 'node:assert/strict';
import { TerminalSessionManager } from ${JSON.stringify(pathToFileURL(path.join(root, 'packages/bush-runtime/dist/index.js')).href)};
import { configureProcessResourceClient } from ${JSON.stringify(pathToFileURL(path.join(root, 'packages/bush-runtime/dist/processes.js')).href)};
import { McpHostBridge, isMcpHostMessage } from ${JSON.stringify(pathToFileURL(path.join(root, 'dist-electron/mcpHostBridge.js')).href)};
import { randomUUID } from 'node:crypto';
const bridge = new McpHostBridge(message => process.parentPort.postMessage(message));
process.parentPort.on('message', event => { if (isMcpHostMessage(event.data)) bridge.receive(event.data); });
let resourceGroup;
configureProcessResourceClient({ async acquire(lifetime, signal, replace) {
  const id = randomUUID();
  const grant = await bridge.request('resources.acquire', { id, lifetime, replace }, signal);
  resourceGroup = grant.groupName;
  return { ...grant, release: () => { void bridge.request('resources.release', { id }); } };
} });
const manager = new TerminalSessionManager();
try {
  const input = { ownerSessionId: 'fixture', command: "Write-Output 'protected-utility-ready'", cwd: ${JSON.stringify(temporary)}, yieldTimeMs: 1000, shell: 'powershell' };
  let result = await manager.start(input), output = result.stdout;
  while (result.state === 'running') { result = await manager.poll('fixture', { sessionId: result.terminalSessionId, yieldTimeMs: 1000 }); output += result.stdout; }
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(output, /protected-utility-ready/);
  const running = await manager.start({ ...input, command: 'Start-Sleep -Seconds 30', yieldTimeMs: 100 });
  assert.equal(running.state, 'running');
  assert.equal((await manager.stop('fixture', running.terminalSessionId)).state, 'stopped');
  process.parentPort.postMessage({ ok: true, resourceGroup });
} catch (error) { process.parentPort.postMessage({ ok: false, error: error.stack || String(error) }); }
`);

let worker, timer, finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (message) console.log(message);
  worker?.kill();
  app.exit(code);
}
app.whenReady().then(async () => {
  timer = setTimeout(() => finish(1, 'Electron main resource test timed out.'), 15000);
  process.env.CARDBUSH_PROCESS_HOST_DIRECTORY = nativeDirectory;
  delete process.env.CARDBUSH_PROCESS_HOST_PATH;
  const { runHostCommand, spawnHostProcess, processOwnerSignal, closeHostProcesses } = require('../dist-electron/hostProcesses.js');
  const mainResult = await runHostCommand({ executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Write($env:CARDBUSH_FIXTURE)'],
    cwd: temporary, env: { ...process.env, CARDBUSH_FIXTURE: 'protected-main-ready' }, timeoutMs: 5000 });
  assert.equal(mainResult.stdout, 'protected-main-ready');
  const window = new (require('electron').BrowserWindow)({ show: false });
  await window.loadURL('data:text/html,<title>Process ownership fixture</title>');
  const reloading = await spawnHostProcess({ executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30'], cwd: temporary,
    signal: processOwnerSignal(window.webContents) });
  reloading.child.stdout.resume(); reloading.child.stderr.resume();
  await window.loadURL('data:text/html,<title>Reloaded owner</title>');
  await reloading.complete();
  assert.notEqual(reloading.child.signalCode ?? reloading.child.exitCode, null);
  const task = await spawnHostProcess({ executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30'], cwd: temporary,
    signal: processOwnerSignal(window.webContents) });
  task.child.stdout.resume(); task.child.stderr.resume();
  assert.equal(task.protected, true);
  window.destroy();
  await task.complete();
  clearTimeout(timer);
  const { HostProcessResourceOwner } = require('../dist-electron/hostProcesses.js');
  const { isMcpHostMessage, handleMcpHostRequest } = await import(pathToFileURL(path.join(root, 'dist-electron/mcpHostBridge.js')).href);
  const { getProcessResourceGovernor } = await import(pathToFileURL(path.join(root, 'packages/bush-runtime/dist/processes.js')).href);
  const resourceOwner = new HostProcessResourceOwner();
  worker = utilityProcess.fork(workerPath, [], {
    env: { ...process.env, CARDBUSH_PROCESS_HOST_PATH: '', CARDBUSH_PROCESS_HOST_DIRECTORY: nativeDirectory },
    serviceName: 'CardBush resource protection test', stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', () => {});
  worker.stderr.on('data', chunk => process.stderr.write(chunk));
  worker.on('message', async result => {
    if (isMcpHostMessage(result)) {
      if (result.type === 'request') worker.postMessage(await handleMcpHostRequest(result, new AbortController().signal,
        (operation, payload, signal) => resourceOwner.handle(operation, payload, signal)));
      return;
    }
    try { assert.equal(result.ok, true, result.error); assert.equal(result.resourceGroup, getProcessResourceGovernor().groupName);
      await closeHostProcesses(); finish(0, 'Electron main/UtilityProcess share private resource admission and native jobs; window/worker cleanup and relocated native host passed.'); }
    catch (error) { finish(1, error.stack); }
  });
  worker.on('exit', () => { resourceOwner.close(); if (!finished) finish(1, 'Resource test worker exited before completing.'); });
  timer = setTimeout(() => finish(1, 'Electron resource test timed out.'), 15000);
}).catch(error => finish(1, error.stack));
process.on('exit', () => {
  assert.equal(path.dirname(path.resolve(temporary)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* A terminated native process may still be releasing its executable. */ }
});
