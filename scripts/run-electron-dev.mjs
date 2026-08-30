import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  cardbushElectronEnvironment,
  resolveCardbushElectronExecutable,
} from './cardbush-electron-runtime.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const electronBin = resolveCardbushElectronExecutable(projectRoot);

const child = spawn(electronBin, ['.'], {
  cwd: projectRoot,
  env: cardbushElectronEnvironment({
    CARDBUSH_DEVELOPMENT_RUNTIME: '1',
    CARDBUSH_ELECTRON_DEV_SERVER_URL:
      process.env.CARDBUSH_ELECTRON_DEV_SERVER_URL || 'http://127.0.0.1:5173',
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
