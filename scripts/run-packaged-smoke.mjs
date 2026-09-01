import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const executable = packagedExecutable(root);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'cardbush-packaged-smoke-'));
const resultPath = path.join(temporaryRoot, 'result.json');
const userDataPath = path.join(temporaryRoot, 'user-data');

try {
  const exitCode = await launch(executable, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
  ], {
    ...withoutProviderCredentials(process.env),
    CARDBUSH_PACKAGED_SMOKE_RESULT: resultPath,
    CARDBUSH_WINDOW_COMPOSITION_DEBUG: '0',
  });
  const report = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(exitCode, 0, report.error || `Packaged app exited with ${exitCode}.`);
  assert.equal(report.protocol, 'cardbush.packaged_smoke.v1');
  assert.equal(report.success, true, JSON.stringify(report, null, 2));
  assert.equal(report.packaged, true);
  assert.equal(report.rendererReady, true);
  assert.equal(report.runtimeCapabilitiesReady, true);
  assert.equal(report.productHostReady, true);
  assert.equal(report.shutdownClean, true);
  assert.equal(Object.values(report.assets).every(Boolean), true);
  console.log('packaged application smoke passed', JSON.stringify({
    executable,
    elapsedMs: report.elapsedMs,
    runtimeElapsedMs: report.runtimeStatus?.elapsedMs,
    assets: report.assets,
  }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function packagedExecutable(repositoryRoot) {
  if (process.platform === 'win32') {
    return path.join(repositoryRoot, 'release-smoke', 'win-unpacked', 'CardBush.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(
      repositoryRoot,
      'release-smoke',
      'mac',
      'CardBush.app',
      'Contents',
      'MacOS',
      'CardBush',
    );
  }
  return path.join(repositoryRoot, 'release-smoke', 'linux-unpacked', 'cardbush');
}

function launch(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged application smoke timed out.\n${stderr}`));
    }, 45_000);
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
}

function withoutProviderCredentials(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => ![
    'CARDBUSH_RUNTIME_PROVIDER_API_KEY',
    'CARDBUSH_RUNTIME_PROVIDER_BASE_URL',
    'CARDBUSH_RUNTIME_PROVIDER_TIMEOUT_MS',
  ].includes(key)));
}
