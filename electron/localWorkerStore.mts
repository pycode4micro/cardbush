import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentConnectionManager } from './agentConnections.mjs';
import { workerCredentialCipher, discardLegacyWorkerCache, openHeadlessWorkers } from './headlessWorkerStore.mjs';
import { assertConnectorFile, secureConnectorResourceAsync } from './browserConnectorFiles.js';
import { withWorkerStoreLock } from './workerStoreLock.mjs';
import { localCliDataRoot, localDesktopProfile } from './localProfilePaths.mjs';

type Options = { legacyRoot?: string; nativeHostPath?: string; manager?: AgentConnectionManager['options'] };

function nativeWorkerHost() {
  const installation = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return installation.endsWith('.asar') ? join(dirname(installation), 'chrome-native-host', 'CardBushBrowserHost.exe')
    : join(installation, 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
}

/** One user/profile-owned registry; no Runtime, model or plugin startup required.
 * Windows protects the key with current-user DPAPI and verifies its private ACL.
 * Unix requires an independently managed credential key. */
export async function openLocalWorkers(profile = localDesktopProfile(), options: Options = {}) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const root = await realpath(profile), directory = join(root, 'workers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || dirname(await realpath(directory)) !== root) throw Error('Worker store must belong to this profile.');
  const native = options.nativeHostPath ?? nativeWorkerHost();
  if (process.platform !== 'win32') {
    await discardLegacyWorkerCache(join(root, 'agents'));
    return openHeadlessWorkers(root, options.manager);
  }
  await secureConnectorResourceAsync(native, 'directory', directory);
  const keyFile = join(directory, 'credentials.dpapi');
  const key = await withWorkerStoreLock(keyFile, async () => {
    assertConnectorFile(keyFile);
    let stored = await readFile(keyFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    const protect = (value: Buffer, operation: string) => {
      try { return Buffer.from(execFileSync(native, [operation], { input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8192 }).trim(), 'base64'); }
      catch { throw Error('Worker credential protection failed for this OS account.'); }
    };
    if (!stored) {
      const exists = await lstat(join(directory, 'connections.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      if (exists) throw Error('worker_credential_key_missing');
      const fresh = randomBytes(32);
      stored = protect(fresh, '--protect-worker-key');
      await writeFile(keyFile, stored, { flag: 'wx', mode: 0o600 });
      fresh.fill(0);
    }
    const value = protect(stored, '--unprotect-worker-key');
    if (value.length !== 32) throw Error('Invalid worker credential store.');
    return value;
  });
  const manager = new AgentConnectionManager(join(directory, 'connections.json'), workerCredentialCipher(key), options.manager);
  // Retired caches are discarded, never imported into the shared registry.
  const legacy = join(resolve(options.legacyRoot ?? localCliDataRoot()), 'workers');
  if (legacy !== directory) await discardLegacyWorkerCache(legacy);
  await discardLegacyWorkerCache(join(root, 'agents'));
  return manager;
}
