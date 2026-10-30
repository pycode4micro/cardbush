import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentConnectionManager } from './agentConnections.mjs';
import { workerCredentialCipher } from './headlessWorkerStore.mjs';
import { assertConnectorFile, secureConnectorResourceAsync } from './browserConnectorFiles.js';
import { withWorkerStoreLock } from './workerStoreLock.mjs';
import { localCliDataRoot, localDesktopProfile } from './localProfilePaths.mjs';

type Cipher = AgentConnectionManager['cipher'];
type Options = { legacyRoot?: string; desktopCipher?: Cipher; nativeHostPath?: string; manager?: AgentConnectionManager['options'] };

function nativeWorkerHost() {
  const installation = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return installation.endsWith('.asar') ? join(dirname(installation), 'chrome-native-host', 'CardBushBrowserHost.exe')
    : join(installation, 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
}

/** One user/profile-owned registry; no Runtime, model or plugin startup required.
 * Windows protects the key with current-user DPAPI and verifies its private ACL.
 * Unix uses the same private service-account boundary as headless credentials. */
export async function openLocalWorkers(profile = localDesktopProfile(), options: Options = {}) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const root = await realpath(profile), directory = join(root, 'workers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || dirname(await realpath(directory)) !== root) throw Error('Worker store must belong to this profile.');
  const native = options.nativeHostPath ?? nativeWorkerHost();
  if (process.platform === 'win32') await secureConnectorResourceAsync(native, 'directory', directory);
  else await chmod(directory, 0o700);
  const keyFile = join(directory, process.platform === 'win32' ? 'credentials.dpapi' : 'credentials.key');
  const key = await withWorkerStoreLock(keyFile, async () => {
    assertConnectorFile(keyFile);
    let stored = await readFile(keyFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    const protect = (value: Buffer, operation: string) => {
      try { return Buffer.from(execFileSync(native, [operation], { input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8192 }).trim(), 'base64'); }
      catch { throw Error('Worker credential protection failed for this OS account.'); }
    };
    if (!stored) {
      const fresh = randomBytes(32);
      stored = process.platform === 'win32' ? protect(fresh, '--protect-worker-key') : fresh;
      await writeFile(keyFile, stored, { flag: 'wx', mode: 0o600 });
      if (stored !== fresh) fresh.fill(0);
    }
    const value = process.platform === 'win32' ? protect(stored, '--unprotect-worker-key') : stored;
    if (value.length !== 32) throw Error('Invalid worker credential store.');
    return value;
  });
  const manager = new AgentConnectionManager(join(directory, 'connections.json'), workerCredentialCipher(key), options.manager);
  // No new legacy directories/keys are created just to discover old connections.
  const legacy = join(resolve(options.legacyRoot ?? localCliDataRoot()), 'workers');
  if (legacy !== directory && !await manager.hasImportedLegacy(join(legacy, 'connections.json'))) {
    const file = join(legacy, 'connections.json'); assertConnectorFile(file);
    const exists = await lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return false; });
    if (exists) {
      const legacyKeyFile = join(legacy, 'credentials.key'); assertConnectorFile(legacyKeyFile);
      const legacyKey = await readFile(legacyKeyFile);
      if (legacyKey.length !== 32) throw Error('Invalid legacy worker credential store.');
      await manager.importLegacy(new AgentConnectionManager(file, workerCredentialCipher(legacyKey)));
    }
  }
  if (options.desktopCipher) await manager.importLegacy(new AgentConnectionManager(join(root, 'agents', 'connections.json'), options.desktopCipher));
  return manager;
}
