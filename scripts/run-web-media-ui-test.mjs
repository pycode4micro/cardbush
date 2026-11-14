import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileRange } from '../dist-electron/webFileResponse.mjs';

const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'web-media-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
const media = await readFile('scripts/fixtures/inspector-media.webm');
const audio = Buffer.alloc(44 + 16000); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(16000, 40);
let requests = 0;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/api/web/v1/files/view') {
      assert.equal(url.searchParams.get('owner'), 'alice'); requests++;
      const wav = url.searchParams.get('path').endsWith('.wav'), bytes = wav ? audio : media;
      const range = fileRange(req.headers.range, bytes.length); assert.ok(range);
      res.writeHead(range.partial ? 206 : 200, { 'Content-Type': wav ? 'audio/wav' : 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': range.end - range.start + 1, ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` } : {}) });
      res.end(bytes.subarray(range.start, range.end + 1)); return;
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
    const file = join(directory, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(resolve(file).startsWith(directory + sep));
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file));
  } catch (error) { console.error(error); res.writeHead(500).end(); }
});
try {
  await writeFile(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';
import {NativeTranscript} from '${local('web/NativeTranscript.tsx')}';
import {BrowserCacheContext} from '${local('web/BrowserCacheProvider.tsx')}';
import '${local('web/styles.css')}';import '${local('web/nativeTranscript.css')}';
const cache={owner:'alice',valid:()=>true,onClose:()=>()=>{},get:async()=>undefined,put:()=>{}};
const state={conversation:{id:'session',title:'Media'},jobs:[],snapshot:{turns:[{turnId:'turn',status:'completed',messages:[{messageId:'reply',turnId:'turn',message:{role:'assistant',content:'![Clip](/data/workspaces/generated/clip.webm)\\n\\n![Audio](/data/workspaces/generated/audio.wav)'}}]}]}};
createRoot(document.getElementById('root')).render(<BrowserCacheContext.Provider value={cache}><NativeTranscript state={state} selected="session" live={{}} modelName="Fixture" onError={console.error} onRetry={()=>{}}/></BrowserCacheContext.Provider>);`);
  const result = await build({ configFile: false, logLevel: 'warn', base: './', build: { outDir: directory, emptyOutDir: false, rollupOptions: { input: join(directory, 'entry.tsx') } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output), entry = output.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">${output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(createRequire(import.meta.url)('electron'), ['scripts/test-web-media-ui.cjs', directory, `http://127.0.0.1:${server.address().port}/`], { env, windowsHide: true, stdio: 'inherit' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0); assert.ok(requests >= 2);
} finally {
  server.closeAllConnections(); server.close();
  assert.ok(directory.startsWith(parent + sep + 'web-media-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
