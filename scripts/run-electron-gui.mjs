import { spawn } from 'node:child_process';
import path from 'node:path';

import { resolveCardbushElectronExecutable } from './cardbush-electron-runtime.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const electronBin = resolveCardbushElectronExecutable(projectRoot);
const child = spawn(electronBin, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CARDBUSH_DEVELOPMENT_RUNTIME: '1',
  },
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
