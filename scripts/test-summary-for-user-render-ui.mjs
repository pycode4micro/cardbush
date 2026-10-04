import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'summary-render-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import { normalizeChatMessagesForDisplay, normalizeActiveTurnTranscriptForDisplay } from '${local('src/features/chatMessages/transcript/messageProjection.ts')}';
const root = createRoot(document.getElementById('root'));
const noop = async () => {};
window.cardbushDesktop = {};
window.show = (phase, content = '最终答复第一段') => {
  const sending = phase !== 'done', final = phase === 'final' || phase === 'done';
  const raw = [{id:'u',role:'user',turnId:'t',createdAt:'2026-10-04T07:09:00Z',content:'我的习惯都有哪些'},
    {id:'first',role:'assistant',turnId:'t',createdAt:'2026-10-04T07:10:00Z',content:'检查习惯记录',metadata:{transcript_kind:'assistant_segment'},
      toolExecutions:[{id:'read',name:'check_habit',state:'completed',summary:'读取习惯',output:'{}',success:true,contentOffset:0,durationMs:10,createdAt:'2026-10-04T07:10:00Z',metadata:{}}]},
    {id:'last',role:'assistant',turnId:'t',content,createdAt:'2026-10-04T07:11:00Z',
      status:sending?'streaming':'completed',metadata:{transcript_kind:final?'assistant_final':'assistant_segment'},
      ...(phase==='corrected'?{toolExecutions:[{id:'second-read',name:'check_habit',state:'running',output:'',success:null,contentOffset:0,durationMs:0,createdAt:'2026-10-04T07:12:00Z',summary:'补查习惯',metadata:{}}]}:{})}];
  const normalized = normalizeChatMessagesForDisplay(raw);
  const messages = sending ? normalizeActiveTurnTranscriptForDisplay(normalized, 't') : normalized;
  window.projected = messages;
  const message = messages.at(-1);
  root.render(<MessageBubble message={message} language="zh" sending={sending} activeTurnId={sending?'t':''}
    activeAssistantMessageId={sending?message.id:''} onRegenerate={noop} onEditUserMessage={noop}
    onRetryGuidance={noop} onRevertChangeReport={noop} onOpenScene={noop}/>);
};
const show = window.show;
window.show = (...args) => { try { return show(...args); } catch (error) { console.error(error.stack); throw error; } };
`;
try {
  await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{
      name: 'summary-render-fixture',
      resolveId(id) { if (id.endsWith('__summary_render__.tsx')) return '\0summary-render.tsx'; },
      load(id) { if (id === '\0summary-render.tsx') return source; },
    }], build: { outDir: directory, emptyOutDir: false, minify: false,
      lib: { entry: resolve('__summary_render__.tsx'), formats: ['es'], fileName: () => 'fixture.js' } } });
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><meta charset="utf-8"><div id="root"></div><script type="module" src="fixture.js"></script></html>');
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-summary-for-user-render-ui-worker.cjs', directory], {
    env, windowsHide: true, stdio: 'inherit', timeout: 45_000,
  });
  assert.equal(run.status, 0, String(run.error ?? 'Final display UI regression failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'summary-render-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
