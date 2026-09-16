import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const configRoot = process.platform === 'win32'
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const sourcePath = process.env.CARDBUSH_THEME_CONTEXT_PATH
  || path.join(configRoot, 'cardbush', 'appearance', 'current-theme.json');

try {
  const context = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  if (context.version !== 1 || !['light', 'dark'].includes(context.colorScheme)
    || !context.theme || !context.background || !context.fontFamily
    || !context.tokens?.['--text'] || !context.tokens?.['--bg']) {
    throw new Error('Unsupported or incomplete theme snapshot.');
  }
  console.log(JSON.stringify({ sourcePath, ...context }, null, 2));
} catch (error) {
  console.error(`Cannot read the current CardBush theme at ${sourcePath}: ${error.message}\nUse an available UI inspection tool to inspect the current CardBush appearance. Do not assume a theme or modify app settings.`);
  process.exitCode = 1;
}
