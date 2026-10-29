import { randomBytes } from 'node:crypto';
import { chmod, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentService } from './agentService.mjs';
import { serveAgentHttp } from './agentServer.mjs';
import { AgentChatDiagnostics } from './agentChatDiagnostics.mjs';
import { LocalModelAccessClient } from './localModelAccess.mjs';
import { claimAgentDataDirectory, localRuntimeDirectory, localRuntimeEndpoint, localRuntimeProtocol } from './agentLocalRuntime.mjs';
import { assertConnectorFile, secureConnectorResourceAsync } from './browserConnectorFiles.js';
import { writePrivateJson } from './atomicJsonFile.mjs';

async function run() {
  const [dataRoot, profileRoot, bundledRoot] = process.argv.slice(2);
  if (!dataRoot || !profileRoot || !bundledRoot) throw new Error('Local Runtime requires data, profile and installation directories.');
  // Windows pipes and Linux abstract sockets are released by the OS on crash.
  // Elect before stale PID-file recovery so simultaneous restarters cannot both
  // remove a crashed owner's lock. Other hosts retain AgentService's file lock.
  const election = await claimAgentDataDirectory(dataRoot);
  const diagnostics = new AgentChatDiagnostics(join(dataRoot, 'logs', 'runtime.log'));
  const access = new LocalModelAccessClient(profileRoot);
  let service: AgentService;
  try {
    service = await AgentService.open({ dataRoot, localProfileRoot: profileRoot, bundledRoot, local: true,
      name: 'CardBush CLI', runtimeDiagnostic: diagnostics.write, localModelAccess: access });
  } catch (error) { election?.close(); access.close(); diagnostics.close(); throw error; }
  const token = randomBytes(32).toString('hex'), endpoint = localRuntimeEndpoint(randomBytes(16).toString('hex'));
  let clients = 0, closing = false, checking = false, timer: ReturnType<typeof setTimeout> | undefined;
  let http: Awaited<ReturnType<typeof serveAgentHttp>> | undefined;
  let descriptor = '';
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    closing = true; clearTimeout(timer);
    try {
      // Startup owns publication. Wait for it to settle before removing its
      // resources, otherwise it can publish a descriptor after shutdown.
      await startup?.catch(() => undefined);
      if (descriptor) {
        const data = await readFile(descriptor, 'utf8').then(JSON.parse).catch(() => null);
        if (data?.token === token) await rm(descriptor, { force: true }).catch(error => {
          // A Windows reader may briefly hold the descriptor. Closing the host
          // must still finish; the next owner replaces this stale private file.
          diagnostics.write('stderr', `Local Runtime descriptor cleanup failed: ${String(error)}\n`);
        });
      }
      try { await http?.close(); } finally { await service.close(); }
    } catch (error) {
      diagnostics.write('stderr', `Local Runtime shutdown failed: ${String(error)}\n`);
      throw error;
    } finally {
      election?.close(); access.close(); diagnostics.close();
      if (process.platform !== 'win32') await rm(endpoint, { force: true });
    }
  })();
  const shutdownFailure = () => { process.exitCode = 1; };
  // A dead worker cannot answer the idle query. Retire its owner even while a
  // client is attached, so reopening/reconnecting can elect a healthy host.
  void service.runtime.failure.then(async error => {
    if (closing) return;
    process.exitCode = 1;
    diagnostics.write('stderr', `Local Runtime worker failed; shutting down: ${error.message}\n`);
    await stop();
  }).catch(shutdownFailure);
  const schedule = (ms = 1000) => {
    clearTimeout(timer);
    if (!closing && !clients) timer = setTimeout(() => { void idle().catch(error => {
      diagnostics.write('stderr', `Local Runtime idle check failed: ${String(error)}\n`); schedule(5000);
    }); }, ms);
  };
  const idle = async () => {
    if (closing || clients || checking) return;
    checking = true;
    try {
      const jobs = await service.call('chat.jobs', {}) as Array<{ status: string }>;
      const activity = await service.runtime.transport.sendCommand({ kind: 'runtime.local_activity', payload: {} }) as { active: boolean };
      if (clients || http?.activeRequests() || activity.active || jobs.some(job => ['queued', 'running'].includes(job.status))) { schedule(); return; }
      await stop();
    } finally { checking = false; }
  };
  const start = async () => {
    const assertStarting = () => { if (closing) throw new Error('Local Runtime stopped during startup.'); };
    const directory = await localRuntimeDirectory(dataRoot);
    const nativeHost = resolve(bundledRoot, '..', 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
    // Named-pipe ACL inspection opens the pipe. Keep the event loop accepting
    // connections while the native helper sets and verifies its private DACL.
    const secure = (kind: 'directory' | 'pipe', target: string) => secureConnectorResourceAsync(nativeHost, kind, target);
    if (process.platform === 'win32') await secure('directory', directory);
    else await chmod(directory, 0o700);
    assertStarting();
    http = await serveAgentHttp(service, { socketPath: endpoint, token,
      localRequest: async (path, request, response, signal) => {
        if (closing) { response.writeHead(503).end(); return; }
        if (path === 'reload' && request.method === 'POST') {
          await service.product.refreshMcp(); response.writeHead(200).end('{}'); return;
        }
        if (path !== 'lease' || request.method !== 'GET') { response.writeHead(404).end(); return; }
        clients++; clearTimeout(timer);
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-CardBush-Local-Runtime': localRuntimeProtocol });
        const status = () => { if (!signal.aborted && !response.writableNeedDrain) response.write(JSON.stringify({ diagnosticsError: diagnostics.error }) + '\n'); };
        status(); const heartbeat = setInterval(status, 5000);
        try { await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), { once: true }); }); }
        finally { clearInterval(heartbeat); clients--; schedule(); }
      },
    });
    if (process.platform === 'win32') await secure('pipe', endpoint);
    else await chmod(endpoint, 0o600);
    assertStarting();
    descriptor = join(directory, 'host.json');
    assertConnectorFile(descriptor);
    await writePrivateJson(descriptor, { protocol: localRuntimeProtocol, pid: process.pid, agentId: service.info().id,
      profileRoot, bundledRoot, endpoint, token });
    assertStarting();
    // Startup is detached from the launching window. A lost parent never owns shutdown.
    process.send?.({ ready: true }, () => { if (process.connected) process.disconnect(); });
    schedule(15_000);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().catch(shutdownFailure); });
  try {
    startup = start();
    await startup;
  } catch (error) { await stop(); throw error; }
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const busy = /already owns|Agent lock is invalid/.test(message) || process.platform === 'win32' &&
    ['EPERM', 'EBUSY'].includes(error?.code) && error?.path === join(process.argv[2], 'agent.lock');
  process.exitCode = 1;
  if (process.connected) process.send?.({ error: message, busy }, () => process.disconnect());
});
