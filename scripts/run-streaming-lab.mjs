import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { exportStreamingHistory } from './export-streaming-history.mjs';

const directory = resolve('tmp/streaming-lab');
await mkdir(directory, { recursive: true });
if (process.argv.includes('--history')) await exportStreamingHistory(process.argv.slice(2), directory);
const local = file => resolve(file).replaceAll('\\', '/');
const result = await build({ configFile: false, logLevel: 'warn',
  esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'streaming-lab-entry',
    resolveId(id) { if (id.endsWith('__streaming_lab__.tsx')) return '\0streaming-lab.tsx'; },
    load(id) {
      if (id !== '\0streaming-lab.tsx') return;
      return `import {createRoot} from 'react-dom/client';
        import {StreamingLab} from '${local('src/features/pre_test/streaming/StreamingLab.tsx')}';
        import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
        createRoot(document.getElementById('root')).render(<StreamingLab/>);`;
    },
  }],
  build: { outDir: directory, emptyOutDir: false, minify: false,
    lib: { entry: resolve('__streaming_lab__.tsx'), formats: ['es'], fileName: () => 'streaming-lab.js' } },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="zh"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>CardBush 流式显示对照实验</title>
  ${styles.map(item => `<link rel="stylesheet" href="./${item.fileName}">`).join('')}
  </head><body><div id="root"></div><script type="module" src="./streaming-lab.js"></script></body></html>`);

if (process.argv.includes('--test')) {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-streaming-lab-ui.cjs', directory], {
    env, windowsHide: true, stdio: 'inherit', timeout: 120000,
  });
  assert.equal(run.status, 0, String(run.error ?? 'Streaming lab UI failed'));
} else if (!process.argv.includes('--build-only')) {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1', () => console.log(`Streaming lab: http://127.0.0.1:${server.address().port}`));
}
