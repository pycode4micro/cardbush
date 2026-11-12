// Capture the compiled desktop application using a separate local profile for each language.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packageScreenshots } from './store-screenshots/package.mjs';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.resolve(process.argv[2] ?? path.join(root, 'release-msix', 'store-screenshots', version));
await mkdir(path.join(root, 'tmp'), { recursive: true });
for (const locale of ['zh-CN', 'en-US']) {
  const profile = await mkdtemp(path.join(root, 'tmp', 'store-demo-'));
  const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, HOME: profile, USERPROFILE: profile,
    CARDBUSH_DEVELOPMENT_RUNTIME: '1', CARDBUSH_ELECTRON_DEV_SERVER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const result = spawnSync(createRequire(import.meta.url)('electron'), [
    path.join(import.meta.dirname, 'store-screenshots', 'capture.cjs'), profile, output, locale,
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 100_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Desktop screenshot capture failed for ' + locale);
}
await packageScreenshots(output, version);
