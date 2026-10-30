import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentConnectionManager } from './agentConnections.mjs';

/** Headless credentials belong to this service account, never to the model or renderer. */
export async function openHeadlessWorkers(root: string): Promise<AgentConnectionManager> {
  const directory = join(root, 'workers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyFile = join(directory, 'credentials.key');
  try { await writeFile(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const key = await readFile(keyFile);
  if (key.length !== 32) throw new Error('Invalid worker credential store.');
  return new AgentConnectionManager(join(directory, 'connections.json'), workerCredentialCipher(key));
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
