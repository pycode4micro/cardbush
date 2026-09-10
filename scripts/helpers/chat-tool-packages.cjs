const assert = require('node:assert/strict');

module.exports = async function testChatToolPackages({ run, until, pause, theme = 'theme-dark' }) {
  await run(`
    window.viewTheme = ${JSON.stringify(theme)};
    window.packageSession = 'packages-' + viewTheme;
    window.packageTurn = 'package-turn';
    window.packageState = { [packageSession]: [{ id: 'package-placeholder', role: 'assistant', content: '',
      conversationId: packageSession, turnId: packageTurn }] };
    window.packageExecution = (index, overrides = {}) => ({
      id: 'package-tool-' + index, assistantMessageId: 'msg_package_' + index, turnId: packageTurn,
      name: 'terminal_exec', state: 'completed', summary: 'operation-' + index, output: 'result-' + index,
      success: true, durationMs: 5, contentOffset: 0, sequence: index,
      createdAt: new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString(), metadata: {}, ...overrides,
    });
    window.appendPackageTool = (index, overrides) => {
      packageState = views.appendToolExecution(packageState, packageSession, 'package-placeholder', packageExecution(index, overrides));
    };
    window.renderPackages = () => updateChat({ conversation: { id: packageSession, title: 'Execution packages' },
      messages: packageState[packageSession], loading: false, historyLoading: false, sending: true, activeTurnId: packageTurn });
    appendPackageTool(1); renderPackages();
  `);
  await until("Boolean(document.querySelector('[data-segment-id=package-placeholder] .tool-execution-block'))", 'first tool-only package');
  await run("window.firstPackage = document.querySelector('[data-segment-id=package-placeholder] .tool-execution-block'); void 0;");
  assert.equal(await run("firstPackage.querySelector('.tool-execution-summary').getAttribute('aria-expanded')"), 'false');
  await run(`
    appendPackageTool(2, { name: 'edit_file', metadata: { workspaceChanges: [{
      change_id: 'package-change', path: 'sample.ts', status: 'modified', additions: 1, deletions: 1,
      diff: '--- a/sample.ts\\n+++ b/sample.ts\\n@@ -1 +1 @@\\n-before\\n+after',
    }] } });
    renderPackages();
  `);
  await until("firstPackage.textContent.includes('2')", 'file change joins the existing package');
  assert.equal(await run("firstPackage === document.querySelector('.message-row.streaming .tool-execution-block')"), true, 'a file change cannot replace the package DOM');
  assert.equal(await run("document.querySelectorAll('.message-row.streaming .tool-change-block, .message-row.streaming .tool-execution-detail').length"), 0, 'individual tools and file changes start collapsed');
  await run(`
    for (let index = 3; index <= 100; index++) appendPackageTool(index);
    renderPackages();
  `);
  await until("firstPackage.textContent.includes('100')", '100 contiguous tool-only rounds share one package');
  assert.equal(await run("document.querySelectorAll('.message-row.streaming .tool-execution-block').length"), 1);
  assert.equal(await run("firstPackage.querySelector('.tool-execution-summary').getAttribute('aria-expanded')"), 'false');
  await run("firstPackage.querySelector('.tool-execution-summary').click()");
  await until("firstPackage.querySelectorAll('[data-execution-id]').length === 100", 'expanded package retains all ordinary and editing operations');
  assert.deepEqual(await run("[...firstPackage.querySelectorAll('[data-execution-id]')].map(node => node.dataset.executionId)"),
    Array.from({ length: 100 }, (_, index) => `package-tool-${index + 1}`));
  assert.equal(await run("Boolean(firstPackage.querySelector('.tool-change-block'))"), true, 'diff review remains accessible inside the package');
  assert.equal(await run("firstPackage.querySelectorAll('.tool-execution-row').length"), 100, 'an opened package shows compact execution rows');
  assert.equal(await run("firstPackage.querySelectorAll('.tool-execution-row-content, .tool-execution-output, .tool-output-actions').length"), 0, 'rows do not eagerly render outputs or repeated action bars');
  assert.ok(await run("[...firstPackage.querySelectorAll('.tool-execution-row')].every(row => row.getBoundingClientRect().height <= 32)"), 'each closed execution occupies one line');
  await run("firstPackage.querySelector('[data-execution-id=package-tool-1] .tool-execution-row').click()");
  await until("firstPackage.querySelector('.tool-execution-output')?.textContent === 'result-1'", 'clicking a row reveals its exact output');
  await run("firstPackage.querySelector('[data-execution-id=package-tool-3] .tool-execution-row').click()");
  await until("firstPackage.querySelector('.tool-execution-output')?.textContent === 'result-3'", 'a different row replaces the open detail');
  assert.equal(await run("firstPackage.querySelectorAll('.tool-execution-row-content').length"), 1);
  assert.equal(await run("firstPackage.querySelector('[data-execution-id=package-tool-1] .tool-execution-row').getAttribute('aria-expanded')"), 'false');
  await run(`
    appendPackageTool(101, { name: 'runtime_context_compaction', metadata: { runtimeMaintenance: 'context_compaction', attempt: 1 } });
    renderPackages();
  `);
  await until("firstPackage.querySelectorAll('[data-execution-id]').length === 101", 'appending preserves an explicitly expanded package');
  assert.equal(await run("document.querySelectorAll('.message-row.streaming .tool-execution-block').length"), 1);
  assert.equal(await run("Boolean(firstPackage.querySelector('.runtime-context-compaction-detail'))"), false, 'maintenance also starts as a compact row');
  assert.equal(await run("firstPackage.querySelector('.tool-execution-output')?.textContent"), 'result-3', 'new executions cannot switch the selected detail');
  await run("firstPackage.querySelector('[data-execution-id=package-tool-101] .tool-execution-row').click()");
  await until("Boolean(firstPackage.querySelector('.runtime-context-compaction-detail'))", 'maintenance details remain available on demand');
  assert.equal(await run("firstPackage.querySelectorAll('[data-execution-id]').length"), 101, 'detail views do not duplicate execution identities');
  await run(`
    firstPackage.querySelector('.tool-execution-summary').click();
    packageState = views.appendAssistantDelta(packageState, packageSession, 'package-placeholder', 'New assistant narration starts here.', {
      messageId: 'msg_package_narration', turnId: packageTurn, sequence: 102, createdAt: '2026-09-08T00:01:42Z',
    });
    appendPackageTool(103, { state: 'awaiting_permission', success: false });
    appendPackageTool(104);
    renderPackages();
  `);
  await until("document.querySelectorAll('.message-row.streaming .tool-execution-block').length === 2", 'new narration begins a new execution package');
  assert.equal(await run("firstPackage.isConnected && firstPackage.textContent.includes('101')"), true, 'new calls do not return to the package before the narration');
  await run("window.secondPackage = document.querySelector('[data-segment-id=msg_package_narration] .tool-execution-block'); void 0;");
  assert.equal(await run("secondPackage.textContent.includes('Awaiting permission')"), true, 'required permission remains visible while collapsed');
  assert.equal(await run("Boolean(firstPackage.compareDocumentPosition(document.querySelector('[data-segment-id=msg_package_narration] p')) & Node.DOCUMENT_POSITION_FOLLOWING)"), true);
  await run(`
    appendPackageTool(1, { state: 'failed', success: false });
    appendPackageTool(103);
    renderPackages();
  `);
  await until("firstPackage.textContent.includes('1 failed') && secondPackage.textContent.includes('2 actions')", 'late results update their original package');
  assert.equal(await run("firstPackage.isConnected && secondPackage.isConnected"), true);
  await run(`
    packageState = views.applyTurnTerminalSnapshot(packageState, packageSession, 'package-placeholder', {
      turnId: packageTurn, status: 'stopped', stopped: true, completedAt: '2026-09-08T00:02:00Z',
    });
    updateChat({ messages: packageState[packageSession], sending: false, activeTurnId: '' });
  `);
  await until("document.querySelectorAll('.assistant-active-transcript .tool-execution-block').length === 2", 'Stop preserves compact packages and narration boundaries');
  await run(`renderView(h(views.AssistantLoopHistoryBlock, { history: packageState[packageSession], language: 'en' }))`);
  await until("document.querySelectorAll('.assistant-loop-history .tool-execution-block').length === 2", 'reloaded history uses the same grouping');
  await pause(60);
  console.log('Tool packages passed (' + theme + '): 100 tool-only rounds, mixed edits/maintenance, stable disclosure, narration boundary, late results, Stop and history.');
};
