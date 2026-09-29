// Repeatable local Store screenshots, using real product components and synthetic data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import ts from 'typescript';
import { packageScreenshots } from './store-screenshots/package.mjs';

const root = process.cwd();
const output = path.resolve(process.argv[2] ?? 'release-msix/1.0.5.0-13UXTU/store-screenshots');
await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, 'tmp', 'store-screenshots-'));
const source = ts.createSourceFile('ChatPanel.tsx', await fs.readFile('src/features/chat/ChatPanel.tsx', 'utf8'), ts.ScriptTarget.Latest, true);
const chat = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ChatPanel');
const callbacks = chat.parameters[0].name.elements.map(element => element.name.text).filter(name => /^on[A-Z]/.test(name));
const result = await build({ configFile: false, logLevel: 'warn', define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir: directory, emptyOutDir: false, minify: true, lib: { entry: path.join(root, 'scripts/store-screenshots/fixture.tsx'), formats: ['iife'], name: 'StoreScreenshots' } },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
await fs.writeFile(path.join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script>window.screenshotCallbacks=${JSON.stringify(callbacks)};window.screenshotErrors=[];addEventListener('error',event=>screenshotErrors.push(event.message));addEventListener('unhandledrejection',event=>screenshotErrors.push(String(event.reason)));const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-09-29T02:00:00.000Z']))}static now(){return new RealDate('2026-09-29T02:00:00.000Z').getTime()}};</script><script src="${entry.fileName}"></script></body></html>`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(createRequire(import.meta.url)('electron'), ['scripts/store-screenshots/capture.cjs', directory, output], { env, windowsHide: true, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
if (code !== 0) throw new Error(`Screenshot renderer exited with ${code}`);
await packageScreenshots(output);
