import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const isolated = await mkdtemp(path.join(tmpdir(), 'cardbush-plugin-distribution-'));
const results = [];
for (const name of await readdir(root)) {
  const directory = path.join(root, name);
  const manifest = JSON.parse(await readFile(path.join(directory, '.codex-plugin/plugin.json'), 'utf8')
    .catch(() => readFile(path.join(directory, '.claude-plugin/plugin.json'), 'utf8')));
  const build = JSON.parse(await readFile(path.join(directory, 'portable-build.json'), 'utf8'));
  if (!['python', 'node'].includes(build.kind)) {
    results.push({ id: name, kind: build.kind, passed: true, validation: 'manifest-only; remote authorization is user-specific' });
    continue;
  }
  const user = path.join(isolated, name);
  await mkdir(user, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|windir|ComSpec|SystemDrive|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  Object.assign(env, { APPDATA: user, LOCALAPPDATA: user, USERPROFILE: user, HOME: user, TEMP: user, TMP: user,
    PATH: path.join(process.env.SystemRoot, 'System32'), PYTHONUTF8: '1' });
  if (name === 'qianchuan') {
    const config = path.join(user, 'qianchuan-plugin'); await mkdir(config);
    await writeFile(path.join(config, 'config.env'), [
      'APP_ENV=test', 'LOCAL_API_KEY=isolated-test-key-01234567890123456789',
      'QIANCHUAN_ACCESS_TOKEN=isolated-nonfunctional-test-token',
      'QIANCHUAN_API_BASE_URL=http://127.0.0.1:1', 'QIANCHUAN_ALLOWED_ADVERTISER_IDS=1',
    ].join('\n'));
  }
  const child = spawn(path.join(directory, name + '.exe'), [], { cwd: user, env, windowsHide: true, stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', x => { stderr += x; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const value = JSON.parse(line); pending.get(value.id)?.resolve(value); pending.delete(value.id); }
    catch { /* A protocol timeout reports unexpected stdout without printing secrets. */ }
  });
  child.on('error', error => { for (const item of pending.values()) item.reject(error); });
  child.on('exit', code => { for (const item of pending.values()) item.reject(Error(`Exited ${code}: ${stderr.slice(-3000)}`)); });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Protocol timeout: ' + stderr.slice(-3000))), 30000);
    pending.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-packaging-check', version: '1' } });
    assert.ok(initialized.result?.serverInfo, JSON.stringify(initialized));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await call(2, 'tools/list', {});
    assert.ok(Array.isArray(listed.result?.tools));
    const names = listed.result.tools.map(t => t.name);
    if (name === 'qianchuan') {
      assert.ok(names.includes('qianchuan_upload_video') && names.includes('qianchuan_upload_image'));
      for (const denied of ['qianchuan_call_raw_tool', 'qianchuan_create_ad', 'qianchuan_update_budget',
        'qianchuan_update_ad_status', 'qianchuan_delete_images', 'qianchuan_run_autonomous_budget']) {
        assert.ok(!names.includes(denied));
        const response = await call(10 + names.indexOf(denied), 'tools/call', { name: denied, arguments: {} });
        assert.ok(response.error || response.result?.isError, 'Direct call must also be denied: ' + denied);
      }
    }
    child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Server did not exit after stdin EOF')), 10000);
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Exit ${code}: ${stderr.slice(-3000)}`)); });
    });
    results.push({ id: name, version: manifest.version, passed: true, toolCount: names.length, tools: names, isolatedRuntime: true });
    console.log(JSON.stringify({ id: name, passed: true, toolCount: names.length }));
  } catch (error) {
    results.push({ id: name, passed: false, error: error.message });
    console.error(JSON.stringify({ id: name, passed: false, error: error.message }));
  } finally { child.kill(); lines.close(); }
}
await writeFile(path.join(path.dirname(root), 'plugin-verification.json'), JSON.stringify({ isolated, results }, null, 2));
process.exitCode = results.every(item => item.passed) ? 0 : 1;
