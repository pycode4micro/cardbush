const assert = require('node:assert/strict');

// Exercise the real ChatPanel in StrictMode. These are observable delivery
// guarantees; the Runtime receives every event regardless of display cadence.
module.exports = async ({ run, until, pause }) => {
  await run(`
    window.batchOriginalProps = { ...chatProps };
    window.batchFlush = require(${JSON.stringify(require.resolve('react-dom'))}).flushSync;
    window.batchState = { 'batch-session': [
      { id: 'batch-user', role: 'user', content: 'Batch tools', turnId: 'batch-turn' },
      { id: 'batch-intro', assistantMessageId: 'batch-intro', role: 'assistant', content: 'The existing narration remains.', turnId: 'batch-turn',
        toolExecutions: Array.from({ length: 19 }, (_, i) => ({ id: 'batch-history-' + i,
          name: 'terminal_exec', state: 'completed', success: true, summary: 'Check', output: '',
          metadata: {displayTitle:'Inspect history'}, durationMs: 10, createdAt: '2026-09-15T00:00:00Z', turnId: 'batch-turn',
          contentOffset: 31, contentOffsetExplicit: true })) },
    ] };
    window.batchTool = (id, state = 'completed') => batchFlush(() => {
      batchState = views.appendToolExecution(batchState, 'batch-session', 'batch-intro', {
        id, name: 'terminal_exec', state, success: state === 'completed', summary: 'Check', output: '',
        metadata: {displayTitle:'Inspect ' + id}, durationMs: 10, assistantMessageId: 'owner-' + id, turnId: 'batch-turn',
        createdAt: '2026-09-15T00:00:01Z', contentOffset: 0, contentOffsetExplicit: true,
      });
      updateChat({ messages: batchState['batch-session'] });
    });
    batchFlush(() => updateChat({ activeConversationId: 'batch-session', activeTurnId: 'batch-turn',
      messages: batchState['batch-session'], sending: true, stopping: false, pendingInteraction: null,
      loading: false, historyLoading: false, goalWaiting: false, error: null }));
    window.batchLabel = () => document.querySelector('.tool-execution-label')?.textContent;
    window.batchStatus = () => document.querySelector('.tool-execution-status')?.textContent;
    window.batchObservations = [];
    window.batchObserver = new MutationObserver(() => {
      const label = batchLabel();
      const status = batchStatus();
      if (label !== batchObservations.at(-1)?.label || status !== batchObservations.at(-1)?.status) batchObservations.push({ label, status, at: performance.now() });
    });
    batchObserver.observe(document.querySelector('.message-list'), { subtree: true, childList: true, characterData: true });
  `);
  try {
    await until("batchLabel() === 'Inspect history'", 'initial tool package');
    await until("document.querySelector('.runtime-screen-line.processing small')?.textContent === 'Inspect history'", 'composer shares the action title');
    await run("window.batchRailNode=document.querySelector('.runtime-screen-line.processing');window.batchTitleNode=document.querySelector('.tool-execution-label');void 0");
    await run('batchObservations = []; window.batchStartedAt = performance.now(); batchTool("burst", "queued")');
    await pause(45);
    await run('batchTool("burst", "running")');
    await pause(45);
    await run('batchTool("burst", "completed")');
    assert.equal(await run('batchLabel()'), 'Inspect history', 'a short burst keeps the previous complete frame');
    await until("batchLabel() === 'Inspect burst'", 'latest burst state displayed');
    assert.deepEqual(await run('batchObservations.map(item => [item.label,item.status])'), [['Inspect burst','Returned']], 'queued/running transients never flash between completed frames');
    assert.ok(await run("batchRailNode === document.querySelector('.runtime-screen-line.processing') && batchTitleNode === document.querySelector('.tool-execution-label')"), 'a title update cannot remount either display');
    assert.equal(await run("document.querySelector('.runtime-screen-line.processing small').textContent"), 'Inspect burst');

    await run('batchObservations = []; batchStartedAt = performance.now()');
    for (let i = 0; i < 12; i++) {
      await run(`batchTool('continuous-${i}')`);
      await pause(80);
    }
    const during = await run('({ observations: batchObservations, now: performance.now(), start: batchStartedAt })');
    assert.ok(during.observations.length > 0, 'a continuous stream commits before the stream stops');
    assert.ok(during.observations[0].at - during.start < 850, 'updates are bounded, not a repeatedly reset debounce');
    await until("batchLabel() === 'Inspect continuous-11'", 'continuous stream delivers its newest state');

    // Controls and user input flush synchronously, even with a timer pending.
    await run('batchTool("stopping", "running"); batchFlush(() => updateChat({ stopping: true }))');
    assert.equal(await run('batchLabel()'), 'Inspect stopping', 'Stop request immediately exposes the newest progress');
    assert.equal(await run('batchStatus()'), 'Running');
    await run(`
      batchFlush(() => updateChat({ stopping: false })); batchTool('stopping', 'completed');
      batchFlush(() => updateChat({ sending: false, activeTurnId: '', messages:
        views.applyTurnTerminalSnapshot(batchState, 'batch-session', 'batch-intro', {
          turnId: 'batch-turn', stopped: true, status: 'stopped', completedAt: new Date().toISOString(),
        })['batch-session'] }));
    `);
    assert.equal(await run('batchLabel()'), 'Inspect stopping', 'a stopped turn immediately flushes the last tool result');
    assert.equal(await run('batchStatus()'), 'Returned');
    await run(`
      batchFlush(() => updateChat({ sending: true, activeTurnId: 'batch-turn', messages: batchState['batch-session'] }));
      const finalState = views.markLocalAssistantTurnCompleted(batchState, 'batch-session', 'batch-intro',
        new Date().toISOString(), { messageId: 'batch-final', turnId: 'batch-turn' }, 'Batch final is immediate');
      batchFlush(() => updateChat({ sending: false, activeTurnId: '', messages: finalState['batch-session'] }));
    `);
    assert.equal(await run('document.querySelector(".message-list").textContent.includes("Batch final is immediate")'), true, 'completion immediately displays the final answer');
    await run('batchFlush(() => updateChat({ sending: true, activeTurnId: "batch-turn", messages: batchState["batch-session"] })); batchTool("decision", "awaiting_solution"); batchFlush(() => updateChat({ pendingInteraction: { id: "decision", sessionId: "batch-session", type: "solution_selection", title: "Solution Selection", raw: {}, questions: [] } }))');
    assert.equal(await run('batchStatus()'), 'Awaiting solution selection', 'a required decision bypasses the display buffer');
    await run('batchFlush(() => updateChat({ pendingInteraction: null })); batchTool("decision", "completed"); batchFlush(() => updateChat({ messages: [...batchState["batch-session"], { id: "batch-guidance", role: "user", content: "New guidance is immediate", turnId: "batch-turn" }] }))');
    assert.equal(await run('[...document.querySelectorAll(".user-bubble")].some(node => node.textContent.includes("New guidance is immediate"))'), true, 'new user input is never buffered');

    await run(`
      batchState['batch-session'] = chatProps.messages;
      batchTool('old-session-pending');
      batchFlush(() => updateChat({ activeConversationId: 'batch-other', activeTurnId: 'other-turn',
        messages: [{ id: 'other-user', role: 'user', content: 'Other conversation', turnId: 'other-turn' }] }));
    `);
    assert.equal(await run('document.querySelector(".user-bubble")?.textContent'), 'Other conversation', 'session switches synchronously');
    await pause(650);
    assert.equal(await run('document.querySelector(".user-bubble")?.textContent'), 'Other conversation', 'a prior session timer cannot resurrect its transcript');
    assert.equal(await run('batchLabel()'), undefined);
    console.log('Transcript batching passed: burst coalescing, bounded continuous delivery, Stop/completion, decisions, new input and session isolation.');
  } finally {
    await run('batchObserver.disconnect(); batchFlush(() => updateChat(batchOriginalProps));');
  }
};
