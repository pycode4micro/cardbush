import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
await mkdir('tmp/image-preview-test', { recursive: true });
await build({ configFile: false, logLevel: 'silent', build: {
  outDir: 'tmp/image-preview-test', emptyOutDir: false, minify: false,
  lib: { entry: resolve('src/features/chatMessages/ImagePreviewDialog.tsx'), formats: ['cjs'], fileName: () => 'preview.cjs' },
  rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime', 'lucide-react'] },
} });
env.CARDBUSH_IMAGE_PREVIEW_MODULE = resolve('tmp/image-preview-test/preview.cjs');
for (const preference of ['force-prefers-no-reduced-motion', 'force-prefers-reduced-motion']) {
  const result = spawnSync(require('electron'), ['--' + preference, 'scripts/test-image-preview.cjs'], {
    env, windowsHide: true, stdio: 'inherit', timeout: 30000,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
