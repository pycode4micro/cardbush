import { parseArgs, stripVTControlCharacters } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentService } from './agentService.mjs';
import { serveAgentHttp } from './agentServer.mjs';
import { verifyAgentBundledAssets, verifyAgentBundledMcp } from './agentBundledAssets.mjs';
import { claimAgentDataDirectory } from './agentLocalRuntime.mjs';
import { AgentChatDiagnostics } from './agentChatDiagnostics.mjs';
import { writePrivateJson } from './atomicJsonFile.mjs';
import { defaultServiceDirectory, inspectServiceProcess, readServiceProcess, serviceProcessPath, serviceUrl, startServiceProcess, stopServiceProcess, type ServiceProcess } from './agentServiceProcess.mjs';

async function run() {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string' }, name: { type: 'string' }, transport: { type: 'string', default: 'http' },
    host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4780' }, help: { type: 'boolean' },
    background: { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'boolean' },
    sandbox: { type: 'string' }, 'sandbox-network': { type: 'string' }, desktop: { type: 'boolean', default: false },
    'web-restricted': { type: 'boolean', default: false }, 'disable-tools': { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write(`CardBush Agent service and CLI (Node.js 24, no GUI required)
Usage: cardbush serve [options]
       cardbush serve --background
       cardbush serve --status
       cardbush serve --stop
Alias: cardbush-agent [options]

  --background      Start the same service silently and return when ready
  --status          Show service state and connection/configuration paths
  --stop            Shut down this service and its tasks; preserve data
  --data-dir PATH   Instance data (default: ~/.cardbush/service)
  --host ADDRESS    HTTP listener (default: 127.0.0.1)
  --port PORT       HTTP port (default: 4780)
  --name NAME       Agent display name
  --sandbox MODE    auto, required, or off; otherwise follow saved host settings
  --sandbox-network disabled|enabled (default: disabled)
  --desktop         Optional Linux desktop image only; disabled by default

Sandbox auto isolates approval-mode commands; required enforces isolation
in every permission mode. Without an override, follow host settings and the capability probe.

Without --background, run in this terminal. Background mode survives closing
the launching terminal; it does not register an OS service or boot task.
Windows terminal tools require PowerShell 7 (pwsh); PowerShell 5 is unsupported.
Linux isolation requires bubblewrap and usable user namespaces. Sandbox startup
failure never falls back to host execution. See the bundled cardbush-docs Skill.
The access-token file authenticates clients; config/models.json configures models.
Use HTTPS or an SSH tunnel for remote connections. Tokens are never printed.
`); return;
  }
  if ([values.background, values.status, values.stop].filter(Boolean).length > 1) throw Error('Use only one of --background, --status, or --stop.');
  const dataRoot = resolve(values['data-dir'] || defaultServiceDirectory());
  if (values.status || values.stop) {
    if (values.stop) await stopServiceProcess(dataRoot);
    const record = await inspectServiceProcess(dataRoot);
    printStatus(dataRoot, record); return;
  }
  if (values.transport !== 'http') throw Error('Agent services use HTTP. Use --host and --port.');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port.');
  if (values.sandbox && !['off', 'auto', 'required'].includes(values.sandbox)) throw Error('--sandbox must be off, auto, or required.');
  if (values['sandbox-network'] && !['disabled', 'enabled'].includes(values['sandbox-network'])) throw Error('--sandbox-network must be disabled or enabled.');
  if (values.background) {
    const childArgs = Object.entries({ ...values, 'data-dir': dataRoot }).flatMap(([key, value]) =>
      key === 'background' || value === undefined || value === false ? [] : value === true ? [`--${key}`] : [`--${key}`, String(value)]);
    const result = await startServiceProcess(dataRoot, childArgs);
    printStatus(dataRoot, result.record, result.existing ? 'Already running' : 'Started'); return;
  }
  const bundledRoot = await verifyAgentBundledAssets();
  if (!values['disable-tools'] && !values['web-restricted']) await verifyAgentBundledMcp(resolve(bundledRoot, '..'));
  const ownership = await claimAgentDataDirectory(dataRoot);
  const background = process.connected;
  const diagnostics = background ? new AgentChatDiagnostics(join(dataRoot, 'logs', 'service.log')) : undefined;
  let service: AgentService | undefined, listener: Awaited<ReturnType<typeof serveAgentHttp>> | undefined;
  let record: ServiceProcess | undefined, ready = false, abandoned = false, stopping: Promise<void> | undefined;
  const close = () => stopping ??= (async () => {
    try {
      const results = await Promise.allSettled([listener?.close(), service?.close()]);
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Service cleanup failed.');
    }
    finally {
      try {
        const current = await readServiceProcess(dataRoot).catch(() => undefined);
        if (record && current?.instance === record.instance) await rm(serviceProcessPath(dataRoot), { force: true });
      } finally { ownership.close(); diagnostics?.close(); }
    }
  })();
  const fail = (error: unknown) => { process.exitCode = 1; diagnostics?.write('stderr', `Service shutdown failed: ${String(error)}\n`); };
  // A launcher that disappears before readiness must not leave an unreported host.
  process.once('disconnect', () => { if (!ready) abandoned = true; });
  try {
    service = await AgentService.open({ dataRoot, bundledRoot, name: values.name, desktop: values.desktop,
      toolsEnabled: !values['disable-tools'], webRestricted: values['web-restricted'], runtimeDiagnostic: diagnostics?.write,
      env: { ...(values.sandbox ? { CARDBUSH_EXECUTION_SANDBOX: values.sandbox } : {}),
        ...(values['sandbox-network'] ? { CARDBUSH_SANDBOX_NETWORK: values['sandbox-network'] } : {}) } });
    await service.inspectDesktop();
    const tokenPath = join(dataRoot, 'access-token');
    let token = process.env.CARDBUSH_AGENT_TOKEN?.trim();
    if (!token) {
      token = await readFile(tokenPath, 'utf8').then(value => value.trim()).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return ''; });
      if (!token) { token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); }
    }
    listener = await serveAgentHttp(service, { host: values.host, port, token,
      localRequest: async (path, request, response) => {
        if (path !== 'stop' || request.method !== 'POST') { response.writeHead(404).end(); return; }
        response.writeHead(202, { 'Content-Type': 'application/json' }).end('{"stopping":true}');
        setImmediate(() => { void close().catch(fail); });
      } });
    record = { protocol: 'cardbush.service-process.v1', instance: randomUUID(), pid: process.pid,
      agentId: service.info().id, host: listener.host!, port: listener.port, startedAt: new Date().toISOString() };
    await writePrivateJson(serviceProcessPath(dataRoot), record);
    if (abandoned) throw Error('Service launcher disconnected before readiness.');
    ready = true;
    diagnostics?.write('stderr', `Service ready: ${record.agentId}, PID ${record.pid}.\n`);
    void service.runtime.failure.then(error => { if (stopping) return; diagnostics?.write('stderr', `Runtime failed: ${error.message}\n`); process.exitCode = 1; return close(); }).catch(fail);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().catch(fail); });
    if (background) process.send?.({ ready: true }, () => { if (process.connected) process.disconnect(); });
    else process.stderr.write(`CardBush Agent ${record.agentId} listening on ${serviceUrl(record).replace(/\/$/, '')}\nAPI: /api/agent/v1 (JSON / SSE / NDJSON)\nAccess token: ${process.env.CARDBUSH_AGENT_TOKEN ? 'CARDBUSH_AGENT_TOKEN' : tokenPath}\n`);
  } catch (error) { diagnostics?.write('stderr', `Service startup failed: ${String(error)}\n`); await close().catch(fail); throw error; }
}

function printStatus(root: string, record?: ServiceProcess, state = 'Running') {
  process.stdout.write(record ? `${state}: ${record.agentId}\nURL: ${serviceUrl(record)}\nPID: ${record.pid}\n` : 'Stopped.\n');
  process.stdout.write(`Data: ${root}\nAccess token: ${join(root, 'access-token')}\nModels: ${join(root, 'config', 'models.json')}\nLog: ${join(root, 'logs', 'service.log')}\n`);
}
run().catch(error => {
  process.exitCode = 1;
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  process.stderr.write(message + '\n');
  if (process.connected) process.send?.({ error: message }, () => { if (process.connected) process.disconnect(); });
});
