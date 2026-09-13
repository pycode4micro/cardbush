const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, utilityProcess } = require('electron');

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
  process.parentPort.postMessage({ ok: true });
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
app.whenReady().then(() => {
  worker = utilityProcess.fork(workerPath, [], {
    env: { ...process.env, CARDBUSH_PROCESS_HOST_PATH: '', CARDBUSH_PROCESS_HOST_DIRECTORY: nativeDirectory },
    serviceName: 'CardBush resource protection test', stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', () => {});
  worker.stderr.on('data', chunk => process.stderr.write(chunk));
  worker.on('message', result => {
    try { assert.equal(result.ok, true, result.error); finish(0, 'Electron UtilityProcess protected execution/stop and relocated native host passed.'); }
    catch (error) { finish(1, error.stack); }
  });
  worker.on('exit', () => { if (!finished) finish(1, 'Resource test worker exited before completing.'); });
  timer = setTimeout(() => finish(1, 'Electron resource test timed out.'), 15000);
}).catch(error => finish(1, error.stack));
process.on('exit', () => {
  assert.equal(path.dirname(path.resolve(temporary)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* A terminated native process may still be releasing its executable. */ }
});
