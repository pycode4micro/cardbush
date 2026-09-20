import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'conversation-extraction-ui-'));
try {
  const result = await build({ configFile: false, logLevel: 'warn', define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'no-runtime-in-extraction-ui', enforce: 'pre', resolveId(id) {
      if (id.endsWith('runtime-client/ElectronRuntimeSession')) return '\0extract-runtime';
    }, load(id) { if (id === '\0extract-runtime') return `export function createDesktopRuntimeSession(){throw Error('Unexpected model runtime access');}`; } }],
    build: { outDir: directory, emptyOutDir: true, minify: false,
      lib: { entry: resolve('scripts/fixtures/conversation-extraction.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry); assert.ok(entry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  await writeFile(join(directory, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
const command = (action, input = {}) => ipcRenderer.invoke('extract', {action, ...input});
contextBridge.exposeInMainWorld('cardbushDesktop', { showErrorDialog: payload => command('error', payload), conversationExtracts: {
  preview: selection => command('preview', {selection}), list: () => command('list'),
  save: (selection, kind) => command('save', {selection, kind}), consume: id => command('consume', {id}),
  resolve: (id, contextWindowTokens) => command('resolve', {id, contextWindowTokens}), export: selection => command('export', {selection}),
  onChanged: fn => { const listener = () => fn(); ipcRenderer.on('changed', listener); return () => ipcRenderer.removeListener('changed', listener); }
}});
contextBridge.exposeInMainWorld('testExtract', { fork: sessionId => command('fork', {sessionId}), expire: () => command('expire') });`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const resultRun = spawnSync(require('electron'), ['scripts/test-conversation-extraction-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(resultRun.status, 0, String(resultRun.error ?? 'Conversation extraction UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'conversation-extraction-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
