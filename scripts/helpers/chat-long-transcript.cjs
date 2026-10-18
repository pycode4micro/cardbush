const assert = require('node:assert/strict');

// Offline shape of a long live turn: 500 rounds, 56 narrations, 1,092 tools.
// No user data, provider calls or real tools are needed to exercise the UI.
module.exports = async ({ run, until, pause }) => {
  await run(`
    window.longOriginalProps = { ...chatProps };
    window.longFlush = require(${JSON.stringify(require.resolve('react-dom'))}).flushSync;
    window.longMessages = [
      { id: 'older-final', role: 'assistant', content: 'Earlier completed answer', turnId: 'older-turn', status: 'completed' },
      { id: 'long-user', role: 'user', content: 'Inspect the project', turnId: 'long-turn' },
      ...Array.from({ length: 500 }, (_, i) => ({
        id: 'long-' + i, assistantMessageId: 'long-' + i, role: 'assistant', turnId: 'long-turn',
        conversationId: 'long-session', loopIndex: i, status: 'streaming',
        content: i % 9 === 0 ? 'Progress ' + i + ': verified the previous step.' : '',
        toolExecutions: Array.from({ length: i < 92 ? 3 : 2 }, (_, j) => ({
          id: 'long-tool-' + i + '-' + j, name: 'terminal_exec',
          assistantMessageId: 'long-' + i, turnId: 'long-turn',
          state: 'completed', success: true, summary: 'Checked', output: '', durationMs: 10,
          contentOffset: i % 9 === 0 ? ('Progress ' + i + ': verified the previous step.').length : 0,
          contentOffsetExplicit: true, metadata: { displayTitle: 'Inspect step ' + i },
          createdAt: new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString(),
        })),
      })),
    ];
    window.__transcriptRenders = [];
    longFlush(() => updateChat({ activeConversationId: 'long-session', activeTurnId: 'long-turn',
      messages: longMessages, sending: true, stopping: false, loading: false, historyLoading: false,
      pendingInteraction: null, error: null, goalWaiting: false }));
  `);
  try {
    await until("document.querySelectorAll('.assistant-active-transcript-segment').length === 56", 'all narration groups rendered');
    await pause(160);
    await run(`
      window.longOldNodes = [...document.querySelectorAll('.assistant-active-transcript-segment')];
      __transcriptRenders = [];
      longMessages = longMessages.map(message => message.id === 'long-499' ? { ...message, content: 'Tail update' } : message);
      window.longUpdateStart = performance.now();
      longFlush(() => updateChat({ messages: longMessages }));
      window.longUpdateMs = performance.now() - longUpdateStart;
    `);
    await until("document.querySelector('.assistant-active-transcript').textContent.includes('Tail update')", 'new text delivered immediately');
    const measured = await run('({ renders: [...new Set(__transcriptRenders)], ms: longUpdateMs })');
    console.log('Long transcript tail update:', JSON.stringify(measured));
    assert.ok(measured.renders.length <= 2, `a tail update must not rerender completed groups (${measured.renders.length} rendered)`);
    assert.ok(await run("longOldNodes.every((node, index) => node === document.querySelectorAll('.assistant-active-transcript-segment')[index])"), 'old group DOM and disclosure state remain mounted');

    // Late results must still invalidate their original group, not disappear in a cache.
    await run(`
      __transcriptRenders = [];
      longMessages = longMessages.map(message => message.id === 'long-8' ? { ...message,
        toolExecutions: message.toolExecutions.map((tool, i) => i === 2 ? { ...tool, metadata: { ...tool.metadata, displayTitle: 'Late verified result' } } : tool),
      } : message);
      longFlush(() => updateChat({ messages: longMessages, stopping: true }));
    `);
    await until("document.querySelector('[data-segment-id=\"long-0\"]').textContent.includes('Late verified result')", 'late result enriches its original group');
    const enriched = await run('[...new Set(__transcriptRenders)]');
    assert.ok(enriched.includes('long-0') && enriched.every(id => ['long-0', 'long-495', 'long-499'].includes(id)),
      'only the changed history group and the aggregate tail may rerender');
    await run(`
      const finalState = views.markLocalAssistantTurnCompleted({ 'long-session': longMessages },
        'long-session', 'long-499', new Date().toISOString(),
        { messageId: 'long-final', turnId: 'long-turn' }, 'Long final response');
      longFlush(() => updateChat({ messages: finalState['long-session'], sending: false, activeTurnId: '', stopping: false }));
    `);
    assert.ok(await run('document.querySelector(".message-list").textContent.includes("Long final response")'), 'completion immediately displays the final text');
  } finally {
    await run('delete window.__transcriptRenders; longFlush(() => updateChat(longOriginalProps));');
  }
};
