import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { packageAgent, verifyAgentPackage } from './package-agent.mjs';
import { create as createTar, list as listTar } from 'tar';

const run = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

/** Publish only the staged headless distribution. The development root remains
 * private, and internal workspaces are bundled rather than fetched from npm. */
export async function packageNpm(root, output, { npmCli = process.env.npm_execpath, name } = {}) {
  root = resolve(root); output = resolve(output);
  if (!npmCli) throw new Error('Run through npm run package:npm so the same npm installation performs packing.');
  const source = await readJson(join(root, 'package.json'));
  const lock = await readJson(join(root, 'package-lock.json'));
  const packageName = name ?? source.name;
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('Invalid npm package name.');
  const stage = join(output, 'package');
  // One npm tarball serves Windows and Linux. Never publish a Linux-produced
  // tarball that silently omits the Windows process protection components.
  await packageAgent(root, stage, 'win32');
  const workspaces = [];
  for (const entry of await readdir(join(stage, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(stage, 'packages', entry.name);
    const manifest = await readJson(join(directory, 'package.json'));
    workspaces.push({ directory, manifest });
  }
  const internal = new Set(workspaces.map(item => item.manifest.name));
  const requested = { ...source.dependencies };
  for (const { manifest } of workspaces) Object.assign(requested, manifest.dependencies);
  const dependencies = {};
  for (const [dependency] of Object.entries(requested)) {
    if (internal.has(dependency)) {
      dependencies[dependency] = workspaces.find(item => item.manifest.name === dependency).manifest.version;
    } else {
      const version = lock.packages[`node_modules/${dependency}`]?.version;
      if (!version) throw new Error(`Production dependency is absent from the lockfile: ${dependency}`);
      dependencies[dependency] = version;
    }
  }
  for (const { directory, manifest } of workspaces) {
    dependencies[manifest.name] = manifest.version;
    // npm treats dependencies of a bundled workspace as bundled too, even when
    // also declared at the root. That would skip fetching absent third-party
    // libraries. The release root above owns the combined dependency set.
    const { scripts: _scripts, devDependencies: _dev, workspaces: _workspaces, dependencies: _dependencies, ...runtime } = manifest;
    await writeJson(join(directory, 'package.json'), runtime);
    const bundled = join(stage, 'node_modules', manifest.name);
    await mkdir(join(bundled, '..'), { recursive: true });
    await cp(directory, bundled, { recursive: true });
  }
  const manifest = {
    name: packageName, version: source.version,
    description: 'CardBush Agent service and terminal client; runs without the desktop App',
    license: source.license, author: source.author, repository: source.repository,
    // .mts emits ESM .mjs, while the desktop/shared .ts files emit CommonJS .js.
    // Preserve the source package's module mode instead of reinterpreting them.
    type: source.type, engines: source.engines,
    bin: { cardbush: 'bin/cardbush.mjs', 'cardbush-agent': 'bin/cardbush-agent.mjs' },
    files: ['bin/', 'dist-electron/', 'packages/', 'assets/', 'dist-native/', 'scripts/agent-desktop/',
      'deploy/agent/install-windows-desktop.ps1', 'README.md', 'LICENSE', 'NOTICE'],
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
    bundleDependencies: [...internal].sort(),
    publishConfig: { access: 'public' },
  };
  await writeJson(join(stage, 'package.json'), manifest);
  for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, file), join(stage, file));
  await cp(join(root, 'docs/NPM_AGENT.md'), join(stage, 'README.md'));
  await verifyAgentPackage(stage, 'win32');
  const { stdout } = await run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
    { cwd: stage, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const packed = JSON.parse(stdout);
  const info = Array.isArray(packed) ? packed[0] : packed[packageName];
  if (!info || basename(info.filename) !== info.filename || !info.filename.endsWith('.tgz')) throw new Error('Unexpected npm pack result.');
  try {
    const files = new Set(info.files.map(file => file.path));
    for (const entry of ['bin/cardbush.mjs', 'bin/cardbush-agent.mjs', 'dist-electron/agentChatCli.mjs', 'dist-electron/agentServiceCli.mjs']) {
      if (!files.has(entry)) throw new Error(`npm omitted a required entry point: ${entry}`);
    }
    for (const dependency of internal) {
      if (!files.has(`node_modules/${dependency}/package.json`)) throw new Error(`npm omitted bundled workspace: ${dependency}`);
    }
    for (const path of files) {
      if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|access-token|agent\.json|\.npmrc|\.git|\.venv|__pycache__)(?:\/|$)/.test(path)
        || /^(?:dist\/|logs\/|tmp\/|release\/|node_modules\/electron\/)/.test(path)) {
        throw new Error(`Unexpected private, development or desktop artifact in npm package: ${path}`);
      }
    }
    // npm's Windows pack loses POSIX executable bits on non-bin resources.
    // Keep npm's exact audited file list, then normalize only known executables.
    const executables = new Set(['bin/cardbush.mjs', 'bin/cardbush-agent.mjs', 'assets/runtime-tools/ripgrep/linux-x64/rg']);
    for (const path of executables) if (!files.has(path)) throw new Error(`Missing executable resource: ${path}`);
    const normalized = join(output, 'portable.tgz');
    await createTar({ cwd: stage, file: normalized, gzip: true, portable: true, noMtime: true, prefix: 'package/',
      onWriteEntry: entry => { if (executables.has(entry.path.replace(/^package\//, ''))) entry.stat.mode = (entry.stat.mode & ~0o777) | 0o755; },
    }, [...files].sort());
    const executableModes = new Map();
    await listTar({ file: normalized, onReadEntry: entry => {
      if (executables.has(entry.path.replace(/^package\//, ''))) executableModes.set(entry.path.replace(/^package\//, ''), entry.mode);
    } });
    for (const path of executables) if (!(executableModes.get(path) & 0o111)) throw new Error(`Archive lost executable permissions: ${path}`);
    await rename(normalized, join(output, info.filename));
    const archive = await readFile(join(output, info.filename));
    const report = { name: packageName, version: manifest.version, tarball: join(output, info.filename),
      size: archive.length, unpackedSize: info.unpackedSize, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'),
      bundledWorkspaces: [...internal].sort(), files: info.files.length };
    await writeJson(join(output, 'package-report.json'), report);
    return report;
  } catch (error) {
    // Never leave a failed release tarball looking publishable. filename was
    // checked above; this can only remove this run's output file, not a tree.
    await rm(join(output, info.filename), { force: true });
    await rm(join(output, 'portable.tgz'), { force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, name: { type: 'string' } } });
  const root = resolve(import.meta.dirname, '..');
  const { version } = await readJson(join(root, 'package.json'));
  const output = values.out ?? join(root, 'release', `npm-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  console.log(JSON.stringify(await packageNpm(root, output, { name: values.name }), null, 2));
}
