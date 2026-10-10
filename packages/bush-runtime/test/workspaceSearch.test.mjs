import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchWorkspaceContent } from '../dist/workspaceSearch.js';
import { ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-search-budget-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('cardbush-search-budget-')); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}
const options = (root, extra = {}) => ({ path: root, query: 'needle', regex: false, globs: [], contextBefore: 0, contextAfter: 0,
  outputMode: 'lines', maxResults: 100, maxOutputBytes: 65536, timeoutMs: 10000, includeDependencies: false, ...extra });
async function engine(kind, run) {
  const oldPath = process.env.PATH, oldRg = process.env.CARDBUSH_RG_PATH;
  try {
    if (kind === 'node') { process.env.PATH = ''; delete process.env.CARDBUSH_RG_PATH; }
    else {
      const bundled = fileURLToPath(new URL('../../../assets/runtime-tools/ripgrep/win32-x64/rg.exe', import.meta.url));
      if (process.platform === 'win32' && existsSync(bundled)) process.env.CARDBUSH_RG_PATH = bundled;
    }
    await run();
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldRg === undefined) delete process.env.CARDBUSH_RG_PATH; else process.env.CARDBUSH_RG_PATH = oldRg;
  }
}

for (const kind of ['native', 'node']) {
  test(`${kind}: prunes dependencies and excluded directories, then locates files with minimal output`, async t => engine(kind, async () => {
    const root = temporary(t);
    for (const folder of ['src', 'skip', 'node_modules/pkg', '.venv/lib', '__pycache__']) {
      mkdirSync(join(root, folder), { recursive: true }); writeFileSync(join(root, folder, 'code.ts'), 'needle\n'.repeat(500));
    }
    const input = options(root, { outputMode: 'files', globs: ['**/*.ts', '!skip/**'] });
    const result = await searchWorkspaceContent(root, input, root);
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.deepEqual(result.output.trim().split('\n').map(path => path.replaceAll('\\', '/')), [join(root, 'src/code.ts').replaceAll('\\', '/')]);
    assert.equal(result.returnedResults, 1);
    if (kind === 'node') assert.equal(result.scannedFiles, 1);
    const dependencies = await searchWorkspaceContent(root, { ...input, includeDependencies: true }, root);
    assert.equal(dependencies.returnedResults, 4);
    // Selecting a dependency directory explicitly is also supported.
    const direct = join(root, '.venv');
    const selected = await searchWorkspaceContent(direct, options(direct, { outputMode: 'files' }), root);
    assert.equal(selected.matched, true, JSON.stringify(selected));
  }));

  test(`${kind}: caps lines/context and UTF-8 bytes with truthful partial-result status`, async t => engine(kind, async () => {
    const root = temporary(t); const path = join(root, 'matches.txt');
    writeFileSync(path, 'before\nneedle one\nbetween\nneedle two\nafter\n');
    const input = options(root, { contextBefore: 1, contextAfter: 1 });
    const whole = await searchWorkspaceContent(root, input, root);
    assert.equal(whole.complete, true, JSON.stringify(whole));
    assert.equal(whole.returnedResults, 5); assert.equal(whole.output.split('\n').filter(Boolean).length, 5);
    const partial = await searchWorkspaceContent(root, { ...input, maxResults: 3 }, root);
    assert.equal(partial.complete, false); assert.equal(partial.limitReason, 'max_results'); assert.equal(partial.returnedResults, 3);
    assert.equal(partial.exitCode, 2); assert.equal(partial.matched, true);
    writeFileSync(path, 'needle ' + '中文😀'.repeat(5000));
    const bytes = await searchWorkspaceContent(root, options(root, { maxOutputBytes: 1024 }), root);
    assert.equal(bytes.complete, false); assert.equal(bytes.limitReason, 'max_output_bytes');
    assert.ok(Buffer.byteLength(bytes.output) <= 1024); assert.doesNotMatch(bytes.output, /�/);
  }));
}

test('concurrent identical search calls share execution, but a subsequent call reads changed files', async t => {
  const root = temporary(t); writeFileSync(join(root, 'search.txt'), 'needle first');
  const registry = new ToolRegistry(); registerWorkspaceTools(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected approval'); } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'all_free',
    tools: registry.definitions(), messages: [], metadata: { workspaceDir: root } };
  let index = 0;
  const run = () => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `search-${++index}`, name: 'search_file_content', argumentsText: JSON.stringify({ path: root, query: 'needle' }) },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: index }, undefined, { request, contextMessages: [] });
  const pair = await Promise.all([run(), run()]);
  assert.ok(pair.every(item => item.kind === 'returned'), JSON.stringify(pair));
  assert.equal(pair.filter(item => item.result.reused).length, 1);
  writeFileSync(join(root, 'search.txt'), 'needle updated');
  const later = await run(); assert.match(later.result.output, /updated/); assert.equal(later.result.reused, undefined);
});

test('a cancelled search cannot be reported as a complete no-match', async t => {
  const root = temporary(t), controller = new AbortController(); controller.abort();
  await assert.rejects(searchWorkspaceContent(root, options(root), root, controller.signal), { name: 'AbortError' });
});
