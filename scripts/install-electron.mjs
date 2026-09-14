import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const electronRoot = path.join(projectRoot, 'node_modules', 'electron');
const electronExe = path.join(electronRoot, 'dist', process.platform === 'win32'
  ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const installScript = path.join(electronRoot, 'install.js');

if (fs.existsSync(electronExe)) {
  process.exit(0);
}

if (!fs.existsSync(installScript)) {
  console.error('Electron package is not installed yet. Run npm install first.');
  process.exit(1);
}

const env = { ...process.env };

execFileSync(process.execPath, [installScript], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
