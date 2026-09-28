import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function processHostBuildInputs(root) {
  const sourceDirectory = path.join(root, 'native', 'process-guard');
  return [
    ...fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.cs')).sort()
      .map(name => path.join(sourceDirectory, name)),
    path.join(root, 'scripts', 'build-process-resource-host.mjs'),
    path.join(root, 'scripts', 'lib', 'process-host-build.mjs'),
  ];
}

function artifact(root) {
  const inputs = processHostBuildInputs(root);
  const hash = createHash('sha256');
  for (const input of inputs) hash.update(path.basename(input)).update(fs.readFileSync(input));
  const fileName = `CardBushProcessHost-${hash.digest('hex').slice(0, 16)}.exe`;
  const directory = path.join(root, 'dist-native', 'process-guard');
  return {
    inputs, directory, fileName, output: path.join(directory, fileName),
    manifest: path.join(directory, 'current.json'),
    unavailable: path.join(directory, 'development-unavailable.json'),
  };
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// A development build receipt is NOT a usable-host manifest. Runtime never reads it.
// Match both inputs and output bytes so it cannot hide a subsequent source change,
// missing executable or damaged build behind an old failed startup check.
export function unavailableProcessHostBuild(root) {
  try {
    const files = artifact(root);
    const receipt = JSON.parse(fs.readFileSync(files.unavailable, 'utf8'));
    if (receipt.version === 1 && receipt.fileName === files.fileName
      && receipt.sha256 === digest(files.output) && typeof receipt.detail === 'string') return receipt;
  } catch { /* Missing/stale receipts require another build. */ }
  return undefined;
}

export function buildProcessResourceHost({
  root, platform = process.platform, env = process.env, allowUnavailable = false,
  run = spawnSync, log = console.log, warn = console.warn,
}) {
  if (platform !== 'win32') return;
  const files = artifact(root);
  fs.mkdirSync(files.directory, { recursive: true });
  if (!fs.existsSync(files.output)) {
    const windowsDirectory = env.WINDIR || env.SystemRoot || 'C:\\Windows';
    const compiler = ['Framework64', 'Framework'].map(name =>
      path.join(windowsDirectory, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')
    ).find(candidate => fs.existsSync(candidate));
    if (!compiler) throw new Error('The Windows .NET Framework C# compiler is required to build the process resource host.');
    // Never replace an executable that may be supervising a running task.
    const temporary = path.join(files.directory, `CardBushProcessHost-${process.pid}.exe`);
    try {
      const result = run(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64',
        '/reference:System.Web.Extensions.dll', `/out:${temporary}`,
        ...files.inputs.filter(input => input.endsWith('.cs'))],
      { cwd: root, encoding: 'utf8', windowsHide: true });
      if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || result.stdout || `csc.exe exited with ${result.status}`);
      }
      fs.renameSync(temporary, files.output);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  const probe = run(files.output, ['--capabilities'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  let capabilities;
  try { capabilities = JSON.parse(probe.stdout ?? ''); } catch { /* Reject invalid hosts below. */ }
  if (probe.error || probe.status !== 0 || capabilities?.protocol !== 'cardbush.process-host.v1'
    || capabilities?.sandboxVersion !== 1) {
    const reason = probe.error?.message || probe.stderr?.trim() || `exit=${probe.status}; invalid host capabilities`;
    const detail = `The Windows process host could not pass its startup check: ${files.output}\n${reason}\n`
      + 'The current host manifest was not changed. If Windows Application Control blocked this file, '
      + 'use a publisher-signed build permitted by your policy. Check Microsoft-Windows-CodeIntegrity/Operational for the exact cause.';
    if (allowUnavailable && probe.error) {
      writeJson(files.unavailable, { version: 1, fileName: files.fileName, sha256: digest(files.output), detail });
      warn(`[process-host] ${detail}\nDevelopment GUI build will continue. Protected commands remain unavailable if the current host cannot start.`);
      return { available: false };
    }
    // A broken protocol, compiler error or release check must still stop the build.
    fs.rmSync(files.unavailable, { force: true });
    throw new Error(detail);
  }

  writeJson(files.manifest, { fileName: files.fileName, sandboxVersion: 1 });
  fs.rmSync(files.unavailable, { force: true });
  log('Built and verified CardBush process resource host.');
  return { available: true };
}
