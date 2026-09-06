// Run outside the candidate workspace. These assertions are not copied into it.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [id, workspace] = process.argv.slice(2);
if (!id || !workspace) throw new Error('Expected task id and candidate workspace.');
const load = (path) => import(pathToFileURL(resolve(workspace, path)).href);
globalThis.window = { cardbushDesktop: {} };

if (id.startsWith('queue-')) {
  const { reorderScopedQueue: reorder } = await load('src/features/composer/queueOrdering.ts');
  const items = [{ id: 'a', scope: 'x' }, { id: 'b', scope: 'y' }, { id: 'c', scope: 'x' }, { id: 'd', scope: 'x' }];
  const original = structuredClone(items);
  const move = (a, b) => reorder(items, a, b, item => item.id, item => item.scope);
  assert.equal(move('a', 'b'), items);
  assert.equal(move('missing', 'c'), items);
  assert.equal(move('a', 'a'), items);
  assert.deepEqual(move('a', 'd').map(item => item.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(move('d', 'a').map(item => item.id), ['d', 'b', 'a', 'c']);
  assert.equal(move('a', 'd')[1], items[1]);
  assert.deepEqual(items, original);
} else if (id === 'config-concurrency') {
  const { withConfigFileLock: lock } = await load('packages/cardbush-product-host/src/atomicFiles.ts');
  let value = 0;
  await Promise.all(Array.from({ length: 12 }, (_, i) => lock(resolve(workspace, i % 2 ? './config.json' : 'config.json'), async () => {
    const read = value;
    await delay(2);
    value = read + 1;
    return value;
  })));
  assert.equal(value, 12);
  await assert.rejects(lock('failure-path', async () => { throw new Error('fixture failure'); }));
  assert.equal(await lock('failure-path', async () => 7), 7);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = lock('path-a', () => gate);
  try { assert.equal(await Promise.race([lock('path-b', () => 9), delay(200).then(() => 'blocked')]), 9); }
  finally { release(); await held; }
} else if (id === 'context-usage') {
  const { contextWindowMetrics: metrics } = await load('src/backend/contextWindowUsage.ts');
  assert.deepEqual(metrics({ inputTokens: 9000, lastRequestInputTokens: 250, contextWindowTokens: 1000 }), {
    usedTokens: 250, maxTokens: 1000, remainingTokens: 750, usageRatio: 0.25,
  });
  assert.deepEqual(metrics({ inputTokens: 9000 }, 1000), { maxTokens: 1000 });
  assert.equal(metrics({ lastRequestInputTokens: 1200 }, 1000).remainingTokens, 0);
  assert.equal(metrics({ lastRequestInputTokens: 1200 }, 1000).usageRatio, 1.2);
  assert.equal(metrics({ lastRequestInputTokens: -1 }, 1000).usedTokens, undefined);
  assert.equal(metrics({ lastRequestInputTokens: NaN }, 1000).usedTokens, undefined);
} else if (id === 'local-url-encoding') {
  const { fileUrl } = await load('src/shared/localPaths.ts');
  const expected = 'cardbush-file:///C:/My%20Files/%E6%B5%8B%E8%AF%95%23%25.png';
  assert.equal(fileUrl('C:\\My Files\\测试#%.png'), expected);
  assert.equal(fileUrl('file:///C:/My%20Files/%E6%B5%8B%E8%AF%95%23%25.png'), expected);
  globalThis.window.cardbushDesktop = undefined;
  assert.equal(fileUrl('C:\\My Files\\测试#%.png'), expected.replace('cardbush-file:', 'file:'));
} else if (id === 'flac-preview') {
  const { isAudioPath } = await load('src/shared/localPaths.ts');
  const { inspectorMediaTarget, inspectorSource } = await load('src/features/inspector/inspectorTargets.ts');
  assert.equal(isAudioPath('C:\\mix.FLAC'), true);
  assert.equal(inspectorMediaTarget('C:\\mix#final.flac').kind, 'audio');
  assert.equal(inspectorSource('C:\\mix#final.flac'), 'file:///C:/mix%23final.flac');
  assert.equal(inspectorSource('\\\\server\\share\\mix.FLAC'), 'file://server/share/mix.FLAC');
  assert.equal(inspectorMediaTarget('C:\\image.png').kind, 'image');
  assert.equal(inspectorMediaTarget('C:\\movie.mp4').kind, 'video');
  assert.match(inspectorSource('C:\\notes.txt'), /^cardbush-file:\/\/text-preview/);
} else if (id === 'markdown-code-boundary') {
  const { normalizeMarkdownContentForDisplay: normalize } = await load('src/features/chatMessages/markdownFormat.ts');
  const url = '**https://example.com/a**';
  assert.equal(normalize(url), '**[https://example.com/a](https://example.com/a)**');
  for (const value of ['```text\r\n' + url + '\r\n```', '`' + url + '`', '``a ` ' + url + '``']) {
    assert.equal(normalize(value), value);
  }
  assert.equal(normalize('```powershell Get-Location\n```'), '```powershell\nGet-Location\n```');
} else if (id === 'file-reference-boundary') {
  const { remarkLocalFileReferences } = await load('src/features/chatMessages/fileReferences.ts');
  // Exercise the public Markdown AST projection rather than checking a regex.
  const project = (value, workspaceRoot = '') => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
    remarkLocalFileReferences({ workspaceRoot })(tree);
    return tree.children[0].children;
  };
  assert.deepEqual(project('日期 2026/9/29'), [{ type: 'text', value: '日期 2026/9/29' }]);
  for (const path of ['/tmp/reports/result.json', 'C:\\repo\\result.json', '\\\\server\\share\\result.json']) {
    assert.equal(project('输出 ' + path).some(node => node.type === 'link'), true);
  }
  assert.equal(project('输出 src/main.ts', '/repo').some(node => node.type === 'link'), true);
} else throw new Error(`Unknown benchmark task: ${id}`);

console.log(JSON.stringify({ taskId: id, passed: true }));
