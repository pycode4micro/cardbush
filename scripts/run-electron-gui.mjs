import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  cardbushElectronEnvironment,
  resolveCardbushElectronExecutable,
} from './cardbush-electron-runtime.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const forceBuild = process.argv.includes('--force-build');
const checkBuildOnly = process.argv.includes('--check-build');

function filesUnder(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules') pending.push(target);
      } else if (predicate(target)) {
        result.push(target);
      }
    }
  }
  return result;
}

function newestMtime(files) {
  return files.reduce((latest, file) => Math.max(latest, fs.statSync(file).mtimeMs), 0);
}

function oldestMtime(files) {
  if (files.some((file) => !fs.existsSync(file))) return 0;
  return files.reduce(
    (oldest, file) => Math.min(oldest, fs.statSync(file).mtimeMs),
    Number.POSITIVE_INFINITY,
  );
}

function guiBuildState() {
  const sourceExtension = /\.(?:ts|tsx|mts|mjs|js|jsx|css|scss|svg|png|ico|html)$/i;
  const sources = [
    ...filesUnder(path.join(projectRoot, 'src'), (file) => sourceExtension.test(file)),
    ...filesUnder(path.join(projectRoot, 'electron'), (file) => sourceExtension.test(file)),
  ];
  const packagesRoot = path.join(projectRoot, 'packages');
  const packageDirectories = fs.existsSync(packagesRoot)
    ? fs.readdirSync(packagesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  for (const entry of packageDirectories) {
    const packageRoot = path.join(packagesRoot, entry.name);
    sources.push(...filesUnder(path.join(packageRoot, 'src'), (file) => sourceExtension.test(file)));
    for (const configName of ['package.json', 'tsconfig.json']) {
      const configPath = path.join(packageRoot, configName);
      if (fs.existsSync(configPath)) sources.push(configPath);
    }
  }
  for (const configName of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.node.json',
    'vite.config.mts',
    'index.html',
  ]) {
    const configPath = path.join(projectRoot, configName);
    if (fs.existsSync(configPath)) sources.push(configPath);
  }
  const outputs = [
    path.join(projectRoot, 'dist', 'index.html'),
    path.join(projectRoot, 'dist-electron', 'main.js'),
    path.join(projectRoot, 'dist-electron', 'preload.js'),
    ...packageDirectories.map((entry) =>
      path.join(packagesRoot, entry.name, 'dist', 'index.js')
    ),
  ];
  const newestSource = newestMtime(sources);
  const oldestOutput = oldestMtime(outputs);
  return {
    current: oldestOutput >= newestSource && oldestOutput > 0,
    missingOutput: outputs.find((file) => !fs.existsSync(file)),
    newestSource,
    oldestOutput,
  };
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const npmCli = resolveNpmCli();
    const build = spawn(process.env.npm_node_execpath || process.execPath, [
      npmCli,
      'run',
      'build',
    ], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });
    build.once('error', reject);
    build.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`GUI build stopped by ${signal}.`));
      } else if (code !== 0) {
        reject(new Error(`GUI build failed with exit code ${code ?? 'unknown'}.`));
      } else {
        resolve();
      }
    });
  });
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim());
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) {
    throw new Error(
      'Unable to locate npm-cli.js. Start CardBush with `npm run gui` or reinstall npm next to Node.js.',
    );
  }
  return npmCli;
}

const buildState = guiBuildState();
if (forceBuild || !buildState.current) {
  const reason = forceBuild
    ? 'forced rebuild'
    : buildState.missingOutput
      ? `missing ${path.relative(projectRoot, buildState.missingOutput)}`
      : 'source files changed';
  console.log(`[gui] ${reason}; building before launch.`);
  await runBuild();
} else {
  console.log('[gui] build is current; launching immediately.');
}

if (checkBuildOnly) process.exit(0);

const electronBin = resolveCardbushElectronExecutable(projectRoot);
const child = spawn(electronBin, ['.'], {
  cwd: projectRoot,
  env: cardbushElectronEnvironment({
    CARDBUSH_DEVELOPMENT_RUNTIME: '1',
  }),
  stdio: 'inherit',
  shell: false,
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
