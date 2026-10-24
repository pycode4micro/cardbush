import { fork } from 'node:child_process';
import { mkdir, lstat, readFile, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AgentHttpClient } from './agentHttpClient.mjs';
import { assertConnectorFile } from './chromeConnectorFiles.js';

export const localRuntimeProtocol = 'cardbush.local-runtime.v1';
export const localRuntimeDescriptor = z.object({
  protocol: z.literal(localRuntimeProtocol), pid: z.number().int().positive(), agentId: z.string().min(1),
  profileRoot: z.string(), bundledRoot: z.string(), endpoint: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Descriptor = z.infer<typeof localRuntimeDescriptor>;
const closingFile = (error: unknown) => process.platform === 'win32' && ['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');

export async function localRuntimeDirectory(root: string) {
  const directory = join(root, 'local-runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || dirname(await realpath(directory)) !== root) {
    throw new Error('Local Runtime metadata must stay inside its data directory.');
  }
  return directory;
}
export function localRuntimeEndpoint(id: string) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\cardbush-cli-${id}` : join(tmpdir(), `cardbush-cli-${id}.sock`);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export async function readLocalRuntime(directory: string): Promise<Descriptor | undefined> {
  const path = join(directory, 'host.json'); assertConnectorFile(path);
  let value: string;
  try {
    if ((await lstat(path)).size > 16_384) throw new Error('Invalid local Runtime descriptor.');
    value = await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const data = localRuntimeDescriptor.parse(JSON.parse(value));
  const id = /cardbush-cli-([a-f0-9]{32})(?:\.sock)?$/.exec(data.endpoint)?.[1];
  if (!id || data.endpoint !== localRuntimeEndpoint(id)) throw new Error('Invalid local Runtime endpoint.');
  return data;
}

/** One private IPC connection owns a client lease. All calls still use the existing
 * authenticated Agent API, including event replay, admission and cancellation. */
async function attach(data: Descriptor) {
  const client = new AgentHttpClient('http://localhost/', data.token, data.agentId, (_options, callback) => {
    const socket = createConnection(data.endpoint);
    const failed = (error: Error) => callback(error, null);
    socket.once('error', failed);
    socket.once('connect', () => { socket.off('error', failed); callback(null, socket); });
    return socket;
  });
  const lifetime = new AbortController();
  const timeout = setTimeout(() => lifetime.abort(), 3000);
  try {
    const response = await client.localRequest('lease', lifetime.signal);
    clearTimeout(timeout);
    if (!response.body || response.headers.get('x-cardbush-local-runtime') !== localRuntimeProtocol) throw new Error('Invalid local Runtime lease.');
    const reader = response.body.getReader();
    const diagnostics: { error?: string } = {};
    const monitor = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Local Runtime disconnected. Reopen the CLI to resume; submitted tasks are not replayed.');
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 8192) throw new Error('Invalid local Runtime status.');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const status = JSON.parse(buffer.slice(0, end)) as { diagnosticsError?: string };
          buffer = buffer.slice(end + 1); diagnostics.error = status.diagnosticsError;
        }
      }
    })().catch(() => { lifetime.abort(); client.close(); }).finally(() => reader.releaseLock());
    return { client, diagnostics, async close() { lifetime.abort(); client.close(); await monitor; } };
  } catch (error) { clearTimeout(timeout); lifetime.abort(); client.close(); throw error; }
}

export async function connectLocalRuntime(dataRoot: string, profileRoot: string, bundledRoot: string) {
  const directory = await localRuntimeDirectory(dataRoot);
  const deadline = Date.now() + 60_000;
  type StartupAttempt = { settled: boolean; error?: Error; retryAfter: number };
  let startup: StartupAttempt | undefined;
  const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  while (Date.now() < deadline) {
    let data: Descriptor | undefined;
    try { data = await readLocalRuntime(directory); }
    catch (error) { if (!closingFile(error)) throw error; await delay(100); continue; }
    if (data && alive(data.pid)) {
      if (!samePath(data.profileRoot, profileRoot) || !samePath(data.bundledRoot, bundledRoot)) {
        throw new Error('This CLI data directory is running with a different profile or installation. Close its CLI windows before switching.');
      }
      try { return await attach(data); } catch { /* The owner may still be starting or finishing its idle shutdown. */ }
    }
    if (!startup) {
      // The service's existing exclusive data lock elects one winner. Losing
      // starters never remove that lock or publish another owner's descriptor.
      const child = fork(new URL('./agentLocalRuntimeHost.mjs', import.meta.url), [dataRoot, profileRoot, bundledRoot], {
        cwd: resolve(bundledRoot, '..'), detached: true, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      // Keep callbacks scoped to this attempt. A losing child's late exit must
      // not overwrite the state of its replacement or a successfully elected host.
      const attempt: StartupAttempt = { settled: false, retryAfter: 0 }; startup = attempt;
      child.on('message', (value: unknown) => {
        const message = value as { error?: string; busy?: boolean };
        if (message.error && !message.busy) attempt.error = new Error(message.error);
        attempt.settled = true; attempt.retryAfter = Date.now() + 300;
      });
      child.on('error', error => { attempt.error = error; attempt.settled = true; });
      child.once('close', code => {
        if (!attempt.settled && code) attempt.error = new Error(`Local Runtime startup failed (${code}).`);
        attempt.settled = true;
      });
      child.unref(); child.channel?.unref();
    }
    if (startup.error) throw startup.error;
    if (startup.settled && Date.now() >= startup.retryAfter) {
      let lock: string;
      try { lock = await readFile(join(dataRoot, 'agent.lock'), 'utf8'); }
      catch (error) {
        if (closingFile(error)) { await delay(100); continue; }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        lock = '';
      }
      const owner = Number(lock);
      if (!owner || !alive(owner)) startup = undefined;
    }
    await delay(100);
  }
  throw new Error('Local Runtime did not become available. If an older CLI or Agent service owns this data directory, exit it normally once and reopen cardbush. Otherwise check logs/runtime.log.');
}
