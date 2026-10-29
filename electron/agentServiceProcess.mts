import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AgentHttpClient } from './agentHttpClient.mjs';
import { assertConnectorFile } from './browserConnectorFiles.js';

export const serviceProcessSchema = z.object({
  protocol: z.literal('cardbush.service-process.v1'), instance: z.string().uuid(),
  pid: z.number().int().positive(), agentId: z.string().min(1),
  host: z.string().min(1), port: z.number().int().min(1).max(65535), startedAt: z.string(),
}).strict();
export type ServiceProcess = z.infer<typeof serviceProcessSchema>;
export const defaultServiceDirectory = () => join(homedir(), '.cardbush', 'service');
export const serviceProcessPath = (root: string) => join(root, 'service-process.json');
export function processExists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export async function readServiceProcess(root: string): Promise<ServiceProcess | undefined> {
  const file = serviceProcessPath(root); assertConnectorFile(file);
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (text.length > 8192) throw Error('Invalid service process record.');
  return serviceProcessSchema.parse(JSON.parse(text));
}
export function serviceUrl(record: ServiceProcess) {
  // Management remains on this machine, even when the server listens on all interfaces.
  const address = ['0.0.0.0', 'localhost'].includes(record.host) ? '127.0.0.1' : record.host === '::' ? '::1' : record.host;
  if (!['127.0.0.1', '::1'].includes(address) && !Object.values(networkInterfaces()).flat().some(entry => entry?.address === address)) throw Error('Service record does not identify a local address.');
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${record.port}/`;
}
async function client(root: string, record: ServiceProcess) {
  const tokenPath = join(root, 'access-token'); assertConnectorFile(tokenPath);
  const token = process.env.CARDBUSH_AGENT_TOKEN?.trim() || (await readFile(tokenPath, 'utf8')).trim();
  return new AgentHttpClient(serviceUrl(record), token, record.agentId);
}
export async function inspectServiceProcess(root: string) {
  const record = await readServiceProcess(root);
  if (!record || !processExists(record.pid)) return undefined;
  const api = await client(root, record);
  try { await api.info(AbortSignal.timeout(2000)); return record; }
  finally { api.close(); }
}
export async function stopServiceProcess(root: string) {
  const record = await inspectServiceProcess(root);
  if (!record) return;
  const api = await client(root, record);
  try {
    // Authenticate the instance; never terminate an arbitrary PID from a stale file.
    const response = await api.localRequest('stop', AbortSignal.timeout(5000));
    await response.body?.cancel();
  } finally { api.close(); }
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (!processExists(record.pid)) return;
    const current = await readServiceProcess(root);
    if (current && current.instance !== record.instance) throw Error('Another service started while stopping. Check --status.');
    await delay(100);
  }
  throw Error('Service shutdown is still in progress. Check its log; no process was force-killed.');
}
export async function startServiceProcess(root: string, args: string[]) {
  const existing = await inspectServiceProcess(root);
  if (existing) return { record: existing, existing: true };
  const child = fork(new URL('./agentServiceCli.mjs', import.meta.url), args, {
    cwd: resolve(import.meta.dirname, '..'), detached: true, windowsHide: true,
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let failure: string | undefined, ready = false, settled = false;
  child.on('message', (message: { ready?: boolean; error?: string }) => {
    ready = message?.ready === true; failure = message?.error; settled = true;
  });
  child.on('error', error => { failure = error.message; settled = true; });
  child.once('exit', code => { if (!settled) failure = `Service startup exited (${code}).`; settled = true; });
  child.unref(); child.channel?.unref();
  const deadline = Date.now() + 60_000;
  try {
    while (Date.now() < deadline) {
      if (ready || settled) {
        // Concurrent starters share the existing data-directory owner. A losing
        // child cannot remove that owner's files or stop its process.
        try { const record = await inspectServiceProcess(root); if (record) return { record, existing: !ready }; } catch { /* Owner may still be publishing. */ }
        if (failure && !/already owns|already starting|lock is invalid/i.test(failure)) throw Error(failure);
      }
      await delay(100);
    }
    throw Error(failure || 'Service did not become ready. Check logs/service.log.');
  } finally { if (child.connected) child.disconnect(); }
}
