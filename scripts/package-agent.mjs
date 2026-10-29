import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyProcessResourceHost } from '../packages/bush-runtime/dist/processes.js';
import { verifyAgentBundledAssets, verifyAgentBundledMcp } from '../dist-electron/agentBundledAssets.mjs';

const sourceRoot = resolve(import.meta.dirname, '..');
const required = ['package.json', 'package-lock.json', 'bin/cardbush.mjs', 'bin/cardbush-agent.mjs', 'dist-electron/agentServiceCli.mjs', 'dist-electron/agentServiceProcess.mjs',
  'dist-electron/agentChatCli.mjs', 'dist-electron/agentLocalChat.mjs', 'dist-electron/agentChatModels.mjs', 'dist-electron/agentChatDiagnostics.mjs', 'dist-electron/agentChatShell.mjs',
  'dist-electron/agentLocalRuntime.mjs', 'dist-electron/agentLocalRuntimeHost.mjs', 'dist-electron/agentServer.mjs',
  'dist-electron/localModelAccess.mjs', 'dist-electron/siwcOAuth.mjs',
  'dist-electron/agentChatTerminal.mjs', 'dist-electron/agentChatPresentation.mjs', 'dist-electron/agentChatInput.mjs', 'dist-electron/agentChatCompletion.mjs', 'dist-electron/agentChatViewport.mjs', 'packages/bush-protocol/dist/transcriptPresentation.js',
  'dist-electron/rotatingLog.js', 'dist-electron/pluginTroubleshooting.mjs', 'dist-electron/agentHttpClient.mjs',
  'dist-electron/agentService.mjs', 'dist-electron/agentBundledAssets.mjs', 'dist-electron/agentDesktopProbe.mjs', 'dist-electron/runtimeHostWorker.mjs',
  'dist-electron/agentInteractiveDesktopCli.mjs', 'dist-electron/agentDesktopBridge.mjs', 'dist-electron/desktopMcpServer.mjs',
  'dist-electron/agentBrowserConnector.mjs', 'dist-electron/sharedBrowserConnector.js', 'dist-electron/browserConnectorProfile.js', 'dist-electron/browserConnectorBroker.js', 'dist-electron/browserConnectorFiles.js', 'dist-electron/browserConnectorWebSocket.js', 'dist-electron/browserConnectorConstants.js',
  'deploy/agent/install-windows-desktop.ps1',
  'deploy/agent/README.md', 'assets/skills/cardbush-docs/SKILL.md',
  'assets/skills/cardbush-docs/references/agent-deploy.md', 'assets/skills/cardbush-docs/references/agent-deployment.md',
  'packages/bush-runtime/dist/processResourceGuard.js', 'scripts/agent-desktop/worker.py',
  'scripts/agent-desktop/computer.py', 'scripts/agent-desktop/browser.py'];

/** Check the staged output, not just the development checkout. */
export async function verifyAgentPackage(root, platform = process.platform) {
  for (const file of required) {
    if (!(await stat(join(root, file))).isFile()) throw Error(`Agent package file is missing: ${file}`);
  }
  await verifyAgentBundledAssets(join(root, 'assets'));
  await verifyAgentBundledMcp(root);
  if (platform !== 'win32') return;
  if (!(await stat(join(root, 'dist-native/chrome-connector/CardBushBrowserHost.exe'))).isFile()) throw Error('Agent browser connector component is missing.');
  const directory = join(root, 'dist-native', 'process-guard');
  const manifest = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
  if (manifest.sandboxVersion !== 1 || manifest.sandboxFileVersion !== 3 || manifest.sandboxScopeVersion !== 4 || !/^CardBushProcessHost-[a-f0-9]{16}\.exe$/.test(manifest.fileName)) {
    throw Error('Invalid Agent process host manifest.');
  }
  if (!(await stat(join(directory, manifest.fileName))).isFile()) throw Error('Agent process host executable is missing.');
  // Cross-platform packaging can check files; execution must be checked on the target.
  if (process.platform === 'win32') await verifyProcessResourceHost({
    ...process.env, CARDBUSH_PROCESS_HOST_PATH: '', CARDBUSH_PROCESS_HOST_DIRECTORY: directory,
  });
}

export async function packageAgent(root, output, platform = process.platform) {
  root = resolve(root); output = resolve(output);
  if (output === root || !relative(output, root).startsWith('..') && !isAbsolute(relative(output, root))) {
    throw Error('Agent output must not contain the source checkout.');
  }
  await verifyAgentPackage(root, platform);
  // An existing release is never overwritten. Dependencies are installed on the target.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const filter = source => source !== join(root, 'dist-electron/browserBootstrapRegistration.js')
    && !relative(root, source).split(/[\\/]/).some(part => ['__pycache__', '.venv', '.git'].includes(part) || /^\.env(?:\.|$)/.test(part))
    && !/\.py[co]$/.test(source);
  for (const file of ['package.json', 'package-lock.json', 'bin', 'dist-electron', 'assets']) {
    await cp(join(root, file), join(output, file), { recursive: true, filter });
  }
  await cp(join(root, 'scripts/agent-desktop'), join(output, 'scripts/agent-desktop'), { recursive: true, filter });
  await mkdir(join(output, 'deploy/agent'), { recursive: true });
  await cp(join(root, 'deploy/agent/install-windows-desktop.ps1'), join(output, 'deploy/agent/install-windows-desktop.ps1'));
  await cp(join(root, 'deploy/agent/README.md'), join(output, 'deploy/agent/README.md'));
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = join(root, 'packages', entry.name), to = join(output, 'packages', entry.name);
    const manifest = await stat(join(from, 'package.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!manifest) continue;
    await mkdir(to, { recursive: true });
    await cp(join(from, 'package.json'), join(to, 'package.json'));
    await cp(join(from, 'dist'), join(to, 'dist'), { recursive: true, filter });
    if (await stat(join(from, 'dist-cjs')).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      await cp(join(from, 'dist-cjs'), join(to, 'dist-cjs'), { recursive: true, filter });
    }
  }
  if (platform === 'win32') {
    await mkdir(join(output, 'dist-native/chrome-connector'), { recursive: true });
    await cp(join(root, 'dist-native/chrome-connector/CardBushBrowserHost.exe'), join(output, 'dist-native/chrome-connector/CardBushBrowserHost.exe'));
    const directory = join(root, 'dist-native', 'process-guard');
    const manifest = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
    const destination = join(output, 'dist-native', 'process-guard');
    await mkdir(destination, { recursive: true });
    for (const file of ['current.json', manifest.fileName]) await cp(join(directory, file), join(destination, file));
  }
  await verifyAgentPackage(output, platform);
  await writeFile(join(output, 'DEPLOY.txt'),
    'CardBush Agent core and CLI (no desktop GUI). Install Node.js 24 and npm 10+.\n'
    + 'Windows: install PowerShell 7 (pwsh); Windows PowerShell 5 is unsupported.\n'
    + 'Linux: command/file isolation requires administrator-installed bubblewrap and usable user namespaces.\n'
    + 'In this directory run: npm ci --omit=dev --ignore-scripts\n'
    + 'Service: cardbush serve --background; inspect with --status, stop with --stop.\n'
    + 'Foreground: cardbush serve --data-dir <separate-data-directory>\n'
    + 'Register the terminal command once: npm link --ignore-scripts\n'
    + 'This registers both cardbush and cardbush-agent from this same release.\n'
    + 'For npm deployment, install the tested CardBush tarball globally; both commands are installed together.\n'
    + 'Local chat: enter a working directory and run cardbush (approval) or cardbush --full-access; no service token needed.\n'
    + 'ChatGPT account models reuse the local App sign-in and require the App running. API-key models run independently.\n'
    + 'If no model is configured, edit the displayed models.json using its annotated example, then press Enter to reload.\n'
    + 'Optional service connection: cardbush --url <Agent URL> --token-file <access-token file>\n'
    + 'Resume: cardbush --resume <session-id> (keeps its workspace); options: cardbush --help\n'
    + 'Deploy the whole directory, including dist-native on Windows. Never copy credentials or task data into this release.\n'
    + 'Deployment Skill: assets/skills/cardbush-docs/references/agent-deployment.md\n');
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, verify: { type: 'string' } } });
  if (values.verify) {
    await verifyAgentPackage(resolve(values.verify));
    console.log('Agent package verified.');
  } else {
    const { version } = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    console.log(await packageAgent(sourceRoot, values.out ?? join(sourceRoot, 'release', `agent-${version}-${process.platform}`)));
  }
}
