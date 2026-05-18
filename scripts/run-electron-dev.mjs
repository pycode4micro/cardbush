import { spawn } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

const child = spawn(electronBin, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CARDBUSH_ELECTRON_DEV_SERVER_URL:
      process.env.CARDBUSH_ELECTRON_DEV_SERVER_URL || 'http://127.0.0.1:5173',
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
