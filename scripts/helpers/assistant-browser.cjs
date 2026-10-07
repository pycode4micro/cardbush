const assert = require('node:assert/strict');
const path = require('node:path');

// Conversational parent -> production child dispatcher -> native HTTP Browser Use.
// Only the model response is scripted; no user browser/profile is touched.
module.exports = async ({ router, ui, call, success, failure, guest, pageId, url, directory, until }) => {
  const { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry } = await import('../../packages/bush-runtime/dist/index.js');
  const { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION: parentId } = await import('@cardbush/bush-protocol');
  const sessions = new SessionStore(), tasks = new SubagentTaskStore(), registry = new ToolRegistry();
  sessions.ensureSession(parentId);
  const referenced = await ui(`browserFixture.reference(${JSON.stringify(parentId)},${JSON.stringify(url)})`);
  await ui(`browserFixture.open({target:${JSON.stringify(url)},newTab:true})`);
  await until(() => ui(`Boolean(browserFixture.navigation[browserFixture.activeId]?.guestWebContentsId)`), 'unreferenced tab ready');
  const otherTab = await ui('browserFixture.activeId'), otherPage = await ui('browserFixture.navigation[browserFixture.activeId].guestWebContentsId');
  assert.notEqual(otherPage, pageId);
  let childId, inspected = false, parentRounds = 0, childRounds = 0;
  registry.register({ definition: { name: 'inspect_selected_browser', description: 'Inspect the selected browser', inputSchema: { type: 'object', properties: {} } },
    manifest: { effect_kind: 'observation', operation: 'browser.inspect', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false },
    decodeInput: value => value, execute: async context => {
      childId = context.sessionId;
      assert.notEqual(childId, parentId);
      const pages = success(await call('list_pages', {}, childId));
      assert.deepEqual(pages.pages.map(page => page.id), [pageId], 'only the referenced page is inherited');
      assert.equal(pages.selectedPageId, pageId);
      failure(await call('select_page', { pageId: otherPage }, childId), 'cardbush_page_not_authorized');
      const snapshot = await call('take_snapshot', { query: 'Video opened' }, childId); success(snapshot);
      const uid = snapshot.content[0].text.match(/uid=(cb_\d+) role=button/)?.[1]; assert.ok(uid);
      success(await call('click', { uid }, childId));
      assert.equal(await guest.executeJavaScript('window.clicks'), 2, 'child controls the original visible guest');
      inspected = true; return { read: true, title: 'Same URL browser fixture' };
    } });
  function* response(request, text, calls = []) {
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() }; let sequence = 0;
    yield { ...base, sequence: sequence++, kind: 'response_started' };
    if (text) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
    for (const [index, call] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index, toolCallId: `${request.requestId}-${index}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
    yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
  }
  const host = new InMemoryRuntimeHost({ dataRoot: path.join(directory, 'assistant-runtime'), sessionStore: sessions, toolRegistry: registry, subagentTaskStore: tasks,
    inheritBrowserScope: async (parent, child, signal) => { await router.inheritScope(parent, child, signal); },
    provider: { async *stream(request) {
      if (request.metadata.agentRole === 'child') {
        yield* response(request, childRounds++ ? '页面已核实' : '', childRounds === 1 ? [{ name: 'inspect_selected_browser', args: {} }] : []); return;
      }
      if (!parentRounds++) yield* response(request, '', [{ name: 'subagent', args: { prompt: '读取用户引用的确切标签页，整理页面信息。' } }]);
      else yield* response(request, inspected ? '后台读取完成。' : '正在后台读取。');
    } } });
  try {
    await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'turn', sessionId: parentId,
      entry: { id: 'selected-page', role: 'user', content: referenced.metadata.composerReferenceContent, source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
      profile: assistantProfileSchema.parse({}), parent: { protocol: 'bush.session_turn_request.v1', requestId: 'browser-assistant', sessionId: parentId, turnId: 'browser-assistant-turn', model: 'fixture',
        prefixMessages: [], inputMessages: [{ messageId: 'selected-page', message: { role: 'user', content: referenced.content } }],
        tools: registry.definitions(), metadata: {}, permissionMode: 'task_free' } } });
    await until(() => tasks.list(parentId).some(task => task.status !== 'running'), 'assistant child completion');
    assert.equal(inspected, true, JSON.stringify(tasks.list(parentId)));
    assert.equal(tasks.list(parentId)[0].status, 'completed');
    assert.equal(success(await call('list_pages', {}, parentId)).selectedPageId, pageId, 'child selection does not change parent state');
    const childPage = success(await call('new_page', { url }, childId));
    await router.inheritScope(parentId, childId);
    assert.equal(success(await call('list_pages', {}, childId)).selectedPageId, childPage.id, 'repeated delegation keeps child selection until a new @ binding');
    await ui(`browserFixture.reference(${JSON.stringify(parentId)},${JSON.stringify(url)})`);
    await router.inheritScope(parentId, childId);
    assert.equal(success(await call('list_pages', {}, childId)).selectedPageId, pageId, 'a new explicit mention reaches an existing child');
    await ui(`browserFixture.closeTabs(new Set([${JSON.stringify(childPage.tabId)},${JSON.stringify(otherTab)}]))`);
    return childId;
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
};
