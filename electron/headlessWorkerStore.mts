import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, rm, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AgentConnectionManager } from './agentConnections.mjs';
import { assertPrivateConfigFile, readProtectedJson, secureConfigDirectory, writeProtectedJson } from '@cardbush/platform/credentials';
import { withWorkerStoreLock } from './workerStoreLock.mjs';

export async function discardLegacyWorkerCache(directory: string) {
  const present = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (!present) return;
  if (!present.isDirectory() || present.isSymbolicLink()) throw new Error('credential_config_redirected');
  await withWorkerStoreLock(join(directory, 'connections.json'), async () => {
    const oldKey = await lstat(join(directory, 'credentials.key')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (!oldKey && basename(directory) !== 'agents') return;
    for (const name of ['connections.json', 'credentials.key']) assertPrivateConfigFile(join(directory, name));
    for (const name of ['connections.json', 'credentials.key']) await rm(join(directory, name), { force: true });
  });
}

/** Headless credentials belong to this service account, never to the model or renderer. */
export async function openHeadlessWorkers(root: string, options?: AgentConnectionManager['options']): Promise<AgentConnectionManager> {
  const directory = join(root, 'workers');
  secureConfigDirectory(directory);
  const keyFile = join(directory, 'credentials.protected');
  const key = await withWorkerStoreLock(keyFile, async () => {
    // Retire the insecure sidecar format. Old connections must be added again;
    // never decrypt or import them using a key stored beside their ciphertext.
    const legacy = join(directory, 'credentials.key'); assertPrivateConfigFile(legacy);
    const old = await readFile(legacy).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (old) {
      const connections = join(directory, 'connections.json'); assertPrivateConfigFile(connections);
      await rm(connections, { force: true }); await rm(legacy, { force: true }); old.fill(0);
    }
    let saved: { secret?: string };
    try { saved = readProtectedJson(keyFile) as { secret?: string }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A missing key for an existing store is corruption, not a fresh install.
      const existing = await readFile(join(directory, 'connections.json')).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== 'ENOENT') throw failure; });
      if (existing) throw new Error('worker_credential_key_missing');
      saved = { secret: randomBytes(32).toString('base64') }; writeProtectedJson(keyFile, saved);
    }
    const value = Buffer.from(saved.secret ?? '', 'base64');
    if (value.length !== 32) throw new Error('Invalid worker credential store.');
    return value;
  });
  return new AgentConnectionManager(join(directory, 'connections.json'), workerCredentialCipher(key), options);
}

export function workerCredentialCipher(key: Buffer) {
  return {
    encrypt(value: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    decrypt(value: string) {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length < 28) throw new Error('Invalid worker credential.');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}
