const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    window.terminalUiCalls = [];
    window.terminalUiParentRenders = 0;
    window.terminalUiState = 'running';
    window.terminalUiRuntime = { dispose() { throw Error('must not dispose the shared host runtime'); }, client: {
      async terminalControl(input, signal) {
        terminalUiCalls.push({ ...input });
        signal?.throwIfAborted();
        if (input.action === 'stop') terminalUiState = 'stopped';
        return { terminalSessionId: input.terminalSessionId, state: terminalUiState, startedAt: new Date(Date.now() - 20000).toISOString(), durationMs: 20000, outputIdleMs: 12000 };
      }
    } };
    window.TerminalUiParent = function() {
      terminalUiParentRenders++;
      return h('div', { id: 'terminal-ui-wrapper', style: { paddingTop: '2200px' } }, h(views.TerminalTaskStatus, {
        sessionId: 'owned-session', terminalSessionId: 'owned-terminal', runtime: terminalUiRuntime, language: 'zh'
      }));
    };
    renderView(h(TerminalUiParent));
  `);
  await until(`Boolean(document.querySelector('.terminal-task-status'))`, 'terminal observer mounted');
  await pause(200);
  assert.equal(await run('terminalUiCalls.length'), 0, 'offscreen details must not poll');
  await run(`document.getElementById('terminal-ui-wrapper').style.paddingTop = '0';`);
  await until(`document.querySelector('.terminal-task-status')?.textContent.includes('后台运行')`, 'visible terminal status read');
  assert.equal(await run(`terminalUiCalls.every(call => call.sessionId === 'owned-session' && call.terminalSessionId === 'owned-terminal')`), true);
  await run(`window.terminalUiNode = document.querySelector('.terminal-task-status'); window.terminalUiBefore = terminalUiNode.textContent; window.terminalUiRenderCount = terminalUiParentRenders;`);
  await pause(1300);
  assert.equal(await run('terminalUiParentRenders === terminalUiRenderCount'), true, 'local clock must not rerender the parent transcript');
  assert.equal(await run(`terminalUiNode === document.querySelector('.terminal-task-status')`), true, 'clock updates preserve the element');
  assert.notEqual(await run('terminalUiNode.textContent'), await run('terminalUiBefore'), 'elapsed time advances locally');
  await run(`document.querySelector('.terminal-task-status button').click();`);
  await until(`document.querySelector('.terminal-task-status')?.textContent.includes('已停止')`, 'human stop reflected');
  assert.equal(await run(`terminalUiCalls.filter(call => call.action === 'stop').length`), 1);
  const reads = await run('terminalUiCalls.length');
  await pause(3200);
  assert.equal(await run('terminalUiCalls.length'), reads, 'completed tasks stop polling');
  await run('renderView(null)');
  console.log('Terminal task UI passed: offscreen pause, owned status, stable parent/DOM, local clock, human stop and observer cleanup.');
};
