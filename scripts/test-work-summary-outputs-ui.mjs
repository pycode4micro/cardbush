import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'work-summary-outputs-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationWorkSummary } from '${local('src/features/chat/ConversationWorkSummary.tsx')}';
import { InspectorWebview } from '${local('src/features/inspector/InspectorWebview.tsx')}';
import { inspectorSource } from '${local('src/features/inspector/inspectorTargets.ts')}';
import { OPEN_INSPECTOR_EVENT } from '${local('src/features/inspector/inspectorEvents.ts')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
window.cardbushDesktop = {};
window.reviewRequests = [];
window.openRequests = [];
const root = createRoot(document.getElementById('root'));
const onNavigation = (_, state) => { window.navigation = state; };
function Harness({ artifacts, theme = 'bright', language = 'zh', sessionId = 'fixture' }) {
  const [selected, setSelected] = React.useState(null);
  React.useEffect(() => {
    const open = event => { window.openRequests.push(event.detail); setSelected(event.detail); };
    window.addEventListener(OPEN_INSPECTOR_EVENT, open);
    return () => window.removeEventListener(OPEN_INSPECTOR_EVENT, open);
  }, []);
  const files = ['src/one.tsx', 'src/types.ts', 'prep_refs.py', 'config.json'];
  const changes = sessionId === 'empty' ? [] : [{ id: 'edits', messageId: 'code', fileCount: files.length,
    additions: 88, deletions: 4, files: files.map(path => ({ path, additions: 22, deletions: 1, diff: '', lines: [] })) }];
  const messages = sessionId === 'empty' ? [] : [{ id: 'code', role: 'assistant', content: '' },
    { id: 'answer', role: 'assistant', content: '', toolExecutions: [{ id: 'generate', name: 'generate_media',
      state: 'completed', summary: '已生成媒体', artifacts, createdAt: '2026-09-13T01:00:00Z', metadata: {} }] }];
  return <div className={'app theme-' + theme} style={{ display: 'flex', width: '100%', height: '100vh', padding: 20, gap: 20 }}>
    <div className="chat-panel work-summary-requested" style={{ position: 'relative', flex: '0 0 370px', minWidth: 0 }}>
      <ConversationWorkSummary language={language} sessionId={sessionId} messages={messages} changeReports={changes}
        workspaceRoot="C:/fixture" onOpenChangeReview={path => window.reviewRequests.push(path || '*')} />
    </div>
    <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
      {selected && <InspectorWebview identity="preview" target={selected.target} source={inspectorSource(selected.target)}
        mediaType={selected.mediaType} title={selected.title} language={language}
        onNavigationStateChange={onNavigation} onOpenTarget={()=>{}} />}
    </div>
  </div>;
}
window.mountFixture = options => root.render(<React.StrictMode><Harness {...options} /></React.StrictMode>);
window.unmountFixture = () => root.unmount();
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{
      name: 'work-summary-outputs-fixture', enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('__work_summary_outputs__.tsx')) return '\0work-summary-outputs.tsx';
        if (id.endsWith('runtime-client/ElectronRuntimeSession')) return '\0outputs-runtime';
      },
      load(id) {
        if (id === '\0work-summary-outputs.tsx') return source;
        if (id === '\0outputs-runtime') return `export function createDesktopRuntimeSession(){throw Error('Unexpected backend access in output preview');}`;
      },
    }], build: { outDir: directory, emptyOutDir: true, minify: false,
      lib: { entry: resolve('__work_summary_outputs__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="zh"><head><meta charset="utf-8">${css.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-work-summary-outputs-ui-worker.cjs', directory], {
    env, windowsHide: true, stdio: 'inherit', timeout: 45_000,
  });
  assert.equal(run.status, 0, String(run.error ?? 'Work summary outputs UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'work-summary-outputs-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
