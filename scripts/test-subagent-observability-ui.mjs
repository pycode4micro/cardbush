import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'subagent-ui-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationWorkSummary } from '${local('src/features/chat/ConversationWorkSummary.tsx')}';
import { WorkSummaryInspector } from '${local('src/features/chat/WorkSummaryInspector.tsx')}';
import { fetchSubagentTask } from '${local('src/backend/api.ts')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
const root = createRoot(document.getElementById('root'));
window.taskReads = 0;
let scenario = 0;
window.renderScenario = async (status, language = 'zh') => {
  const id = ++scenario;
  window.runtimeTask = {
    protocol:'bush.subagent_task.v1',taskId:'child-task-'+id,
    parentSessionId:'parent',parentTurnId:'first-turn',childSessionId:'child',childTurnId:'child-turn',
    prompt:'实现接收端网页',finalResponse:status==='completed'?'接收端文件已生成，联调仍需父任务继续。':'',
    status, revision:status==='running'?1:2,inheritContext:true,inheritedMessageCount:95,
    errorMessage:status==='failed'?'连接失败':'',usage:{},
    createdAt:'2026-09-11T14:28:52.580Z',updatedAt:'2026-09-11T14:34:36.092Z',
    ...(status==='running'?{}:{completedAt:'2026-09-11T14:34:36.092Z'})
  };
  // Runtime replies use its actual four-state protocol. No synthetic review
  // fields: exercise the real API projection as well as both mounted views.
  window.fixtureClient = {
    listSubagentTasks:async () => [structuredClone(window.runtimeTask)],
    getSubagentTask:async () => { window.taskReads++; return structuredClone(window.runtimeTask); },
    listSessions:async () => [
      {sessionId:'parent',turns:[{turnId:'first-turn',status:'completed'},{turnId:'later-turn',status:'completed'}]},
      {sessionId:'child',turns:[{turnId:'child-turn',status:window.runtimeTask.status}]}
    ]
  };
  const task = await fetchSubagentTask(window.runtimeTask.taskId);
  root.render(<React.StrictMode><div className="app theme-dark" style={{display:'flex',width:'100%',height:'100vh',padding:24,gap:24}}>
    <div className="chat-panel work-summary-requested" style={{position:'relative',flex:'0 0 370px',minWidth:0}}><ConversationWorkSummary key={'summary-'+id} language={language} sessionId="parent"
      messages={[{id:'later-reply',role:'assistant',content:'其他任务已完成',status:'completed',turnId:'later-turn'}]}
      changeReports={[]} onOpenChangeReview={()=>{}} subagentObservabilityAvailable /></div>
    <div style={{flex:1,minWidth:0}}><WorkSummaryInspector key={'detail-'+id} language={language} messages={[]}
      detail={{kind:'subagent-task',sessionId:'parent',title:'子任务',task}} /></div>
  </div></React.StrictMode>);
};
window.finishTask = () => {
  window.runtimeTask = {...window.runtimeTask,status:'completed',revision:2,
    updatedAt:'2026-09-11T14:35:00Z',completedAt:'2026-09-11T14:35:00Z',finalResponse:'实时任务已完成'};
};
window.unmountFixture = () => root.unmount();
window.renderScenario('completed');
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{
      name: 'subagent-observability-fixture', enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('__subagent_fixture__.tsx')) return '\0subagent-fixture.tsx';
        if (id.endsWith('runtime-client/ElectronRuntimeSession')) return '\0subagent-runtime';
      },
      load(id) {
        if (id === '\0subagent-fixture.tsx') return source;
        if (id === '\0subagent-runtime') return `export function createDesktopRuntimeSession(){return {dispose(){},client:window.fixtureClient};}`;
      },
    }], build: { outDir: directory, emptyOutDir: true, minify: false,
      lib: { entry: resolve('__subagent_fixture__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="zh"><head><meta charset="utf-8">${css.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-subagent-observability-ui-worker.cjs', directory], {
    env, windowsHide: true, stdio: 'inherit', timeout: 30_000,
  });
  assert.equal(run.status, 0, String(run.error ?? 'Subagent UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'subagent-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
