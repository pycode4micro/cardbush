import assert from 'node:assert/strict';
import { build, loadConfigFromFile } from 'vite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'deferred-modules-'));
const outDir = join(directory, 'dist');
const local = file => resolve(file).replaceAll('\\', '/');
const require = createRequire(import.meta.url);
let worker;
try {
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
  await writeFile(join(directory, 'fixture.tsx'), `
import React, { Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolFileChangeView } from '${local('src/features/tools/ToolChangeBlock.tsx')}';
import { SourceInspectorPreview } from '${local('src/features/inspector/TextInspectorPreview.tsx')}';
import { MarkdownContent } from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import { DeferredModuleNotice, recoverableLazy } from '${local('src/shared/recoverableLazy.tsx')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
window.diagnostics = []; window.fatalErrors = []; window.unhandled = []; window.mounts = 0;
window.cardbushDesktop = {
  writeDebugLog: async (_, data) => { window.diagnostics.push(data); },
  readTextPreview: async () => ({ content: 'const preview = 42;\\nconsole.log(preview);', truncated: false }),
};
window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
const Panel = recoverableLazy('test-panel', async () => {
  if (!window.panelReady) throw new TypeError('Failed to fetch dynamically imported module');
  return { default: () => <p id="loaded-panel">Panel recovered</p> };
}, (_, retry) => <DeferredModuleNotice language="zh" retry={retry} />);
class RootBoundary extends React.Component {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  componentDidCatch(error) {window.fatalErrors.push(String(error));}
  render() { return this.state.failed ? <h1 id="fatal">Fatal</h1> : this.props.children; }
}
const file = {path:'fixture.py', additions:1, deletions:1, lines:[
  {kind:'hunk',text:'@@ -8,2 +8,2 @@'},
  {kind:'deletion',text:'-before = 1'},
  {kind:'addition',text:'+after = 2'},
  {kind:'context',text:' print(after)'},
]};
const noop = () => {};
function Harness() {
  const [opened, setOpened] = useState('');
  const [draft, setDraft] = useState('未发送的草稿');
  const [ticks, setTicks] = useState(0);
  useEffect(() => {window.mounts++; const timer = setInterval(() => setTicks(n => n+1), 50); return () => clearInterval(timer);}, []);
  window.openFeature = setOpened;
  return <div className="app theme-light" style={{height:'100vh',display:'block',padding:24}}>
    <textarea id="draft" value={draft} onChange={e=>setDraft(e.target.value)} />
    <p id="live">运行中 <span>{ticks}</span></p>
    <main id="feature"><Suspense fallback={<p>Loading</p>}>
      {opened === 'diff' && <ToolFileChangeView file={file} language="zh" />}
      {opened === 'source' && <SourceInspectorPreview path="fixture.ts" language="zh" onLoadingChange={noop} />}
      {opened === 'markdown' && <MarkdownContent content="## 任务内容仍在\\n\\n请继续处理。" language="zh" />}
      {opened === 'panel' && <Panel />}
    </Suspense></main>
  </div>;
}
createRoot(document.getElementById('root')).render(<RootBoundary><Harness /></RootBoundary>);
`);
  const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve('vite.config.mts'));
  async function compile(version) {
    const result = await build({ ...config, root: directory, configFile: false, logLevel: 'silent',
      plugins: [...config.plugins, {
        name: 'fixture-version',
        transform(code, id) {
          if (id.replaceAll('\\', '/').endsWith('/tools/DiffSyntaxLines.tsx')) {
            return code + `\nwindow.syntaxBuildVersion = ${version};`;
          }
        },
      }],
      build: { ...config.build, outDir, minify: false,
        rolldownOptions: { ...config.build.rolldownOptions, input: join(directory, 'index.html') } },
    });
    return (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  }
  const first = await compile(1);
  const oldSyntax = first.find(item => item.type === 'chunk' && item.fileName.includes('DiffSyntaxLines'));
  assert.ok(oldSyntax, 'the fixture must retain the real lazy chunk boundary');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  worker = spawn(require('electron'), ['scripts/test-deferred-modules-worker.cjs', outDir], {
    env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let rebuildError;
  let passed = false;
  worker.on('message', async message => {
    if (message === 'passed') passed = true;
    if (message !== 'rebuild') return;
    try {
      const second = await compile(2);
      const newSyntax = second.find(item => item.type === 'chunk' && item.fileName.includes('DiffSyntaxLines'));
      assert.notEqual(oldSyntax.fileName, newSyntax.fileName);
      // Check every old import dependency, including its content, not just the
      // top-level syntax module whose missing hash caused the real crash.
      for (const item of first.filter(item => item.type === 'chunk')) {
        assert.equal(await readFile(join(outDir, item.fileName), 'utf8'), item.code);
      }
      worker.send('rebuilt');
    } catch (error) {
      rebuildError = error;
      worker.send('rebuild-failed');
    }
  });
  const status = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  if (rebuildError) throw rebuildError;
  assert.equal(status, 0, 'deferred module browser checks failed');
  assert.ok(passed, 'the browser must complete every recovery scenario');
} finally {
  if (worker && worker.exitCode === null) worker.kill();
  assert.ok(directory.startsWith(parent + sep + 'deferred-modules-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
