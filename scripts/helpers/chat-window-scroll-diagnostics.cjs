const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.diagnosticBatches = [];
    window.originalDiagnosticWriter = cardbushDesktop.writeDebugLog;
    cardbushDesktop.windowScrollDiagnosticConfig = async () => ({ runId: 'fixture', expiresAt: Date.now() + 60000, logPath: 'fixture.log' });
    cardbushDesktop.onWindowScrollDiagnosticEvent = callback => {
      window.sendDiagnosticNativeEvent = callback;
      return () => { if (sendDiagnosticNativeEvent === callback) window.sendDiagnosticNativeEvent = null; };
    };
    cardbushDesktop.writeDebugLog = async (scope, payload) => { if (scope === 'window-scroll') diagnosticBatches.push(payload); return 'fixture.log'; };
    void 0;
  `);
  // Run the existing position assertions with all diagnostic instrumentation on.
  await require('./chat-window-scroll.cjs')({ run, until, pause, window });
  await until("typeof sendDiagnosticNativeEvent === 'function'", 'diagnostic native subscription');
  await run(`
    sendDiagnosticNativeEvent({ event: 'restore', at: new Date().toISOString() });
    function diagnosticScrollProbe() {
      const list = document.querySelector('.message-list');
      list.scrollTo({ top: list.scrollTop + 1, behavior: 'instant' });
      list.scrollTop = 0;
    }
    diagnosticScrollProbe();
  `);
  await pause(2100);
  const batches = await run('diagnosticBatches');
  const records = batches.flatMap(batch => batch.records);
  for (const label of ['geometry', 'js-scroll', 'native:restore', 'window:focus', 'window:blur', 'resize-observer']) {
    assert.ok(records.some(record => record.label === label), 'diagnostics include ' + label);
  }
  assert.ok(records.some(record => record.label === 'js-scroll' && record.stack?.includes('diagnosticScrollProbe')), 'programmatic scroll captures its caller');
  assert.ok(records.some(record => record.label === 'geometry' && record.anchors.some(anchor => anchor.messageId && anchor.nodeId)), 'geometry identifies message DOM nodes');
  assert.ok(batches.every(batch => batch.records.length <= 240), 'capture batches are bounded');
  assert.ok(!JSON.stringify(batches).includes('Window switching, message'), 'diagnostics omit message text');
  await run(`
    window.diagnosticOldScroller = document.querySelector('.message-list');
    cardbushDesktop.windowScrollDiagnosticConfig = async () => undefined;
    updateChat({ activeConversationId: 'diagnostics-disabled' });
  `);
  await until("document.querySelector('.message-list') !== diagnosticOldScroller", 'diagnostic scroller unmounted');
  await pause(200);
  assert.equal(await run("Object.hasOwn(diagnosticOldScroller, 'scrollTop') || Object.hasOwn(diagnosticOldScroller, 'scrollTo')"), false, 'unmount restores native descriptors');
  assert.equal(await run("Object.hasOwn(document.querySelector('.message-list'), 'scrollTo')"), false, 'disabled diagnostics leave the scroller untouched');
  await run('cardbushDesktop.writeDebugLog = originalDiagnosticWriter; delete cardbushDesktop.windowScrollDiagnosticConfig; delete cardbushDesktop.onWindowScrollDiagnosticEvent; void 0');
  console.log('Window diagnostics passed: unchanged scrolling, native events, geometry/DOM identity, JS callers, bounded batches, omitted text and cleanup.');
};
