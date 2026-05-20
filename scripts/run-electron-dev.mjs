import { spawn } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const electronBin =
  process.platform === 'win32'
    ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(projectRoot, 'node_modules', '.bin', 'electron');

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
