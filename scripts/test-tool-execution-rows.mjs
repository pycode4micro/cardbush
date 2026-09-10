import assert from 'node:assert/strict';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'tool-rows-'));
const local = file => resolve(file).replaceAll('\\', '/');
try {
  let apiStubLoaded = false;
  const source = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ToolExecutionBlock} from ${JSON.stringify(local('src/features/tools/ToolExecutionBlock.tsx'))};
    import ${JSON.stringify(local('src/styles/theme.css'))};
    import ${JSON.stringify(local('src/styles/app.css'))};
    import ${JSON.stringify(local('src/styles/themes/cyberpunk.css'))};
    const root = createRoot(document.getElementById('root'));
    window.requests = []; window.copied = [];
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async value=>window.copied.push(value)}});
    const execution = (id, extra={}) => ({id, name:'terminal_exec', summary:'terminal_exec', state:'completed',
      output:'{\\n  "terminalSessionId": "terminal_31",\\n  "pid": 468\\n}', success:true, durationMs:2100, createdAt:'2026-09-10T00:00:00Z',
      turnId:'turn', contentOffset:0, metadata:{}, ...extra});
    window.executions = [execution('shell'), execution('search', {name:'search_file_content', summary:'查找端口与服务配置', durationMs:600,
      output:'原始结果😀\\r\\n'.repeat(200) + '最后一行'}), execution('running', {summary:'Get-NetTCPConnection -LocalPort 8090,8091 -State Listen', state:'running', output:'', durationMs:0})];
    window.active = true; window.theme='theme-dark'; window.messageId = 'message';
    window.renderFixture = () => root.render(<div className={'app ' + window.theme} style={{height:'100vh',padding:'32px',boxSizing:'border-box'}}>
      <div className="message-list" style={{width:'100%',height:'100%',overflow:'auto',display:'block',padding:0}}>
        <div data-message-id={window.messageId}><h3 style={{fontSize:15,margin:'0 0 20px'}}>检查本地服务</h3>
          <ToolExecutionBlock executions={window.executions} active={window.active} language="zh"
            message={{id:window.messageId,conversationId:'fixture',turnId:'turn',createdAt:'2026-09-10T00:00:00Z',role:'assistant',content:''}}
            onOpenScene={()=>{}} onRevertChangeReport={async()=>{}} />
        </div>
      </div>
    </div>);
    renderFixture();
  `;
  const result = await build({ configFile: false, logLevel: 'warn', define: {'process.env.NODE_ENV': '"production"'}, plugins: [react(), {
    name: 'tool-rows-fixture',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('__tool_rows_fixture__.tsx')) return '\0tool-rows-fixture.tsx';
      if (/[/\\]backend[/\\]api(?:\.ts)?$/.test(id)) return '\0tool-rows-api';
    },
    load(id) {
      if (id === '\0tool-rows-fixture.tsx') return source;
      if (id === '\0tool-rows-api') {
        apiStubLoaded = true;
        return `export function dispatchSubagent(){throw Error('Unexpected dispatch');}
          export function fetchRuntimeTurnToolExecutionDetails(input){return new Promise((resolve,reject)=>window.requests.push({input,resolve,reject}));}`;
      }
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false,
    lib: { entry: resolve('__tool_rows_fixture__.tsx'), formats: ['iife'], name: 'ToolRowsFixture' } } });
  assert.ok(apiStubLoaded, 'The fixture must replace real backend access');
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry); assert.ok(entry);
  const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${css.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-tool-execution-rows-worker.cjs', directory], {env, windowsHide:true, stdio:'inherit', timeout:30000});
  assert.equal(run.status, 0, String(run.error ?? 'Tool rows UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'tool-rows-'));
  await rm(directory, {recursive:true,force:true,maxRetries:10,retryDelay:100});
}
