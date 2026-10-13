import assert from 'node:assert/strict';
import test from 'node:test';
import { createCardbushChromeServer, createBrowserUseState } from '../dist/index.js';
import { projectMcpResult } from '../../bush-mcp-client/dist/modelResult.js';

const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'recovery' } } };

test('empty selection and invalid tab ids never become a phantom page zero', async () => {
  for (const listed of [{ pages: [], selectedPageId: null, selectionState: 'none' }, [{ id: null }, { id: false }, { id: '' }]]) {
    const server = createCardbushChromeServer({ connector: async method => { assert.equal(method, 'tabs.list'); return listed; } });
    const result = await server._registeredTools.list_pages.handler({}, context);
    assert.deepEqual(result.structuredContent.pages, []);
    assert.equal(result.structuredContent.selectionState, 'none');
    assert.equal(result.structuredContent.selectedPageId, null);
    assert.equal(result.structuredContent.unavailablePageId, undefined);
  }
});

test('a lost external selection can be listed but never falls back, including after release', async () => {
  let available = [{ id: 1, active: true }, { id: 2, active: false }], commands = 0;
  const server = createCardbushChromeServer({ connector: async (method, params) => {
    if (method === 'tabs.list') return available;
    if (method === 'tabs.close') { available = available.filter(page => page.id !== params.tabId); return { closed: true }; }
    if (method === 'tabs.activate') return { id: params.tabId };
    if (method === 'debugger.detachScope') return {};
    commands++; return { result: { value: 'selected explicitly' } };
  } });
  const call = (name, args = {}) => server._registeredTools[name].handler(args, context);
  assert.equal((await call('list_pages')).structuredContent.selectedPageId, 1);
  await call('close_page');
  available[0].active = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = await call('list_pages');
    assert.equal(listed.isError, undefined);
    assert.deepEqual(listed.structuredContent.pages.map(page => page.id), [2]);
    assert.equal(listed.structuredContent.selectionState, 'missing');
    assert.equal(listed.structuredContent.selectedPageId, null);
    assert.equal((await call('evaluate_script', { expression: 'document.title' })).structuredContent.error.code, 'browser_page_missing');
    await call('release_browser');
  }
  assert.equal(commands, 0);
  await call('select_page', { pageId: 2 });
  assert.equal((await call('evaluate_script', { expression: 'document.title' })).structuredContent.value, 'selected explicitly');
  assert.equal(commands, 1);
});

test('an inherited missing CardBush target blocks implicit selection even without a local selection cache', async () => {
  const server = createCardbushChromeServer({ connector: async method => {
    assert.equal(method, 'tabs.list');
    return { pages: [{ id: 2, active: true, browser: 'cardbush' }], selectedPageId: 1, selectionState: 'missing' };
  } });
  const listed = await server._registeredTools.list_pages.handler({}, context);
  assert.equal(listed.structuredContent.selectionState, 'missing');
  assert.equal(listed.structuredContent.unavailablePageId, 1);
  assert.equal((await server._registeredTools.evaluate_script.handler({ expression: 'document.title' }, context)).isError, true);
});

test('browser evaluation preserves native data and presents its JSON once to the model', async () => {
  const value = { rows: Array.from({ length: 10 }, (_, i) => ({ id: i, label: `unique-row-${i}` })) };
  const server = createCardbushChromeServer({ connector: async method => method === 'tabs.list'
    ? [{ id: 42, active: true }] : { result: { value } } });
  const native = await server._registeredTools.evaluate_script.handler({ expression: 'readData()', resultType: 'json' }, context);
  const before = structuredClone(native);
  assert.deepEqual(JSON.parse(native.content[0].text), native.structuredContent);
  const projected = projectMcpResult(native);
  assert.deepEqual(JSON.parse(projected).structuredContent, { pageId: 42, value });
  assert.equal(projected.split('unique-row-0').length - 1, 1);
  assert.deepEqual(native, before);
});

test('resize reports failure before caching a viewport the page did not apply', async () => {
  const state = createBrowserUseState();
  let writes = 0;
  const server = createCardbushChromeServer({ state, connector: async (method, params) => {
    if (method === 'tabs.list') return [{ id: 42, active: true }];
    if (params.command === 'Page.getLayoutMetrics') return { cssVisualViewport: { zoom: 1 } };
    if (params.command === 'Emulation.setDeviceMetricsOverride') { writes++; return {}; }
    return { result: { value: { width: 521, height: 882, deviceScaleFactor: 1 } } };
  } });
  const resized = await server._registeredTools.resize_page.handler({ width: 473, height: 800 }, context);
  assert.equal(resized.isError, true);
  assert.equal(resized.structuredContent.error.code, 'viewport_not_applied');
  assert.equal(resized.structuredContent.error.details.dimensions.width, 521);
  assert.equal(state.requestedViewports.size, 0);
  assert.equal(writes, 1, 'a mismatch does not start a hidden resize retry loop');
});
