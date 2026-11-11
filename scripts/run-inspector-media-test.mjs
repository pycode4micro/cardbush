import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { build } from 'vite';
import { pdfPreviewAssetsPlugin } from './pdf-preview-assets-plugin.mjs';
const require = createRequire(import.meta.url);
const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, 'inspector-media-'));
try {
  await build({
    configFile: false, root: resolve('scripts/fixtures/inspector-media-preview'), base: './',
    logLevel: 'silent', plugins: [pdfPreviewAssetsPlugin()], build: { outDir: join(scratch, 'app') },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const result = spawnSync(require('electron'), ['scripts/test-inspector-media.cjs', scratch, ...process.argv.slice(2)], {
    env, stdio: 'inherit', timeout: 60000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (dirname(scratch) !== parent || !basename(scratch).startsWith('inspector-media-')) throw Error('Unexpected fixture directory');
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
