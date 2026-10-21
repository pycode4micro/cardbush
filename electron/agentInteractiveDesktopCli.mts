import { parseArgs } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createCardbushAppsServer } from '@cardbush/apps-mcp';
import { runResourceManagedCommand, verifyProcessResourceHost } from '@cardbush/bush-runtime/processes';
import { startDesktopMcpServer } from './desktopMcpServer.mjs';
import { readAgentDesktopBridge, readAgentDesktopBridgePolicy, syncAgentDesktopBridgePolicy } from './agentDesktopBridge.mjs';
import { probeAgentDesktop, findWindowsDesktopPowerShell } from './agentDesktopProbe.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, worker: { type: 'boolean' }, 'sync-policy': { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Windows interactive desktop helper: node dist-electron/agentInteractiveDesktopCli.mjs --data-dir <Agent data directory>\nInstall with deploy/agent/install-windows-desktop.ps1. Runs in the selected logged-in user session; the Agent service keeps its own account.');
} else {
  if (process.platform !== 'win32' || !values['data-dir']) throw Error('Windows and --data-dir are required.');
  const powershell = findWindowsDesktopPowerShell(process.env);
  if (!powershell) throw Error('Windows PowerShell is required for interactive desktop access.');
  process.env.PATH = `${dirname(powershell)};${process.env.PATH ?? ''}`;
  const root = resolve(values['data-dir']);
  const config = readAgentDesktopBridge(join(root, 'desktop-bridge', 'connection.json'));
  if (!config) throw Error('Install the interactive desktop bridge before starting its helper.');
  await verifyProcessResourceHost();
  if (values['sync-policy']) {
    syncAgentDesktopBridgePolicy(join(root, 'desktop-bridge', 'connection.json'), join(root, 'config', 'apps.json'));
  } else if (!values.worker) {
    // The complete MCP process tree, including PowerShell and launched apps,
    // remains in the existing resource guard for the helper's lifetime.
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    const result = await runResourceManagedCommand({ executable: process.execPath,
      args: [fileURLToPath(import.meta.url), '--data-dir', root, '--worker'], cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, lifetime: 'service', signal: abort.signal,
      maxOutputBytes: 64 * 1024, outputLimit: 'truncate' });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) throw Error(`Interactive desktop helper exited (${result.exitCode}).`);
  } else {
    const env = { ...process.env };
    delete env.CARDBUSH_AGENT_DESKTOP_BRIDGE;
    const setup = await probeAgentDesktop(env);
    if (setup.environment !== 'ready') throw Error(`${setup.summary} Start this helper in the logged-in user's interactive session.`);
    const captures = join(root, 'desktop-bridge', 'captures');
    await mkdir(captures, { recursive: true });
    process.env.CARDBUSH_OWNED_CAPTURE_ROOT = captures;
    const server = await startDesktopMcpServer(() => {
      // Read the host's current enabled/config state on every MCP connection.
      // Do not freeze a permissive default when configuration sync changes it.
      const apps = readAgentDesktopBridgePolicy(join(root, 'desktop-bridge', 'apps.json'));
      apps.computerUse.config.screenshotDirectory = captures;
      return createCardbushAppsServer(apps);
    }, { port: config.port, token: config.token, status: async () => ({ agentId: config.agentId, setup: await probeAgentDesktop(env) }) });
    const keepAlive = setInterval(() => {}, 60_000);
    let closing = false;
    const close = () => { if (closing) return; closing = true; clearInterval(keepAlive); void server.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    process.stderr.write('Interactive desktop MCP bridge ready on loopback.\n');
  }
}
