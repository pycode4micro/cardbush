import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const electronRoot = path.join(projectRoot, 'node_modules', 'electron');
const electronExe = path.join(electronRoot, 'dist', 'electron.exe');
const installScript = path.join(electronRoot, 'install.js');

if (process.platform === 'win32' && fs.existsSync(electronExe)) {
  process.exit(0);
}

if (!fs.existsSync(installScript)) {
  console.error('Electron package is not installed yet. Run npm install first.');
  process.exit(1);
}

const env = {
  ...process.env,
  ELECTRON_MIRROR:
    process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
};

execFileSync(process.execPath, [installScript], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
});
