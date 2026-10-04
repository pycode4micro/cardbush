const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`window.guidanceOriginal = { props: { ...chatProps }, theme: window.viewTheme }; void 0;`);
  try {
    for (const [theme, anchor] of ['theme-dark', 'theme-bright'].flatMap(theme =>
      ['guide-seal', 'interrupted-empty-request'].map(anchor => [theme, anchor]))) {
      await run(`
        window.viewTheme = ${JSON.stringify(theme)};
        window.guidanceFixture = [
          { id: 'guide-original', role: 'user', content: 'Check the audio', sequence: 1 },
          { id: 'guide-diagnosis', role: 'assistant', content: 'First, measure the audio.', sequence: 2 },
          { id: 'guide-explanation', role: 'assistant', content: 'The diagnosis is ready.', sequence: 3 },
          { id: 'guide-seal', role: 'assistant', content: '', sequence: 4,
            toolExecutions: [{ id: 'guide-edit', name: 'edit_file', state: 'completed', success: true,
              summary: 'Edit analysis', output: '', durationMs: 1, turnId: 'guide-turn',
              createdAt: '2026-09-15T10:00:03Z', assistantMessageId: 'guide-seal', contentOffset: 0,
              metadata: { kind: 'file_change',
                workspaceChanges: [{ change_id: 'guide-file', path: 'analysis.ps1', status: 'modified',
                  additions: 26, deletions: 0, metadata: { diff: '@@ -0,0 +1,1 @@\\n+check' } }] } }] },
          { id: 'guide-user', role: 'user', content: 'Could the plugin be the cause?', sequence: 3,
            metadata: { turn_guidance: true, guidance_delivery: 'pending' } },
        ].map(message => ({ ...message, turnId: 'guide-turn', conversationId: 'guide-session',
          createdAt: '2026-09-15T10:00:0' + message.sequence + 'Z' }));
        window.showGuidanceFixture = (status = 'streaming') => {
          const messages = guidanceFixture.map(message => message.role !== 'assistant' || message.metadata?.segment_boundary
            ? message : { ...message, status });
          updateChat({ activeConversationId: 'guide-session', messages,
            sending: status === 'streaming', stopping: false, activeTurnId: status === 'streaming' ? 'guide-turn' : '',
            loading: false, historyLoading: false, goalWaiting: false, error: null, draft: '',
            pendingInteraction: null, changeReports: [] });
        };
        window.guidanceToolMessage = guidanceFixture.find(message => message.id === 'guide-seal');
        guidanceFixture = guidanceFixture.filter(message => message.id !== 'guide-seal');
        window.guidancePendingFrames = [];
        window.samplePendingGuidance = () => {
          const rows = [...document.querySelectorAll('.message-row')];
          const guideIndex = rows.findIndex(row => row.textContent.includes('Could the plugin be the cause?'));
          const replyIndex = rows.findIndex(row => row.textContent.includes('The diagnosis is ready.'));
          if (guideIndex >= 0 && replyIndex >= 0) guidancePendingFrames.push({
            guideIndex, replyIndex,
            gap: rows[guideIndex].getBoundingClientRect().top - rows[replyIndex].getBoundingClientRect().bottom,
          });
          window.guidancePendingFrame = requestAnimationFrame(samplePendingGuidance);
        };
        showGuidanceFixture();
        samplePendingGuidance();
      `);
      await until("document.querySelector('.message-list')?.textContent.includes('The diagnosis is ready.')", 'pre-guidance narration');
      await until("document.querySelector('.guidance-activity')?.textContent.includes('Sending guidance')", 'immediate agent-side sending feedback');
      assert.equal(await run("document.querySelectorAll('.user-bubble .guidance-delivery-status').length"), 0);
      await pause(100);
      await run(`
        guidanceFixture = guidanceFixture.map(message => message.id === 'guide-user'
          ? { ...message, status: 'queued', metadata: { ...message.metadata, guidance_delivery: 'queued' } }
          : message);
        guidanceFixture.push(guidanceToolMessage);
        showGuidanceFixture();
      `);
      await until("!!document.querySelector('[data-message-id=guide-seal]')", 'new tool round while guidance is queued');
      await until("document.querySelector('.guidance-activity')?.textContent.includes('Waiting for the current step')", 'queued activity');
      await pause(200);
      const pendingFrames = await run('cancelAnimationFrame(guidancePendingFrame); guidancePendingFrames');
      assert.ok(pendingFrames.length > 0);
      assert.ok(pendingFrames.every(frame => frame.replyIndex === 1 && frame.guideIndex === 2 &&
        frame.gap >= 0 && frame.gap < 80),
      'queued guidance stays below prior output in every rendered frame: ' + JSON.stringify(pendingFrames));
      await fs.writeFile(path.join(root, 'tmp/chat-guidance-queued-' + theme + '.png'), (await window.capturePage()).toPNG());
      await run(`
        guidancePendingFrames = [];
        samplePendingGuidance();
        guidanceFixture = views.applyAssistantSegmentBoundary({ 'guide-session': guidanceFixture },
          'guide-session', 'guide-diagnosis', { kind: 'loop_transition', reason: 'turn_guidance_applied',
            messageId: '', turnId: 'guide-turn', previousAssistantMessageId: ${JSON.stringify(anchor)},
            guidanceMessageId: 'guide-user', sequence: 5 })['guide-session'];
        showGuidanceFixture();
        updateChat({ thinkingVisible: true });
      `);
      await until("document.querySelector('.guidance-activity[data-guidance-state=sent]')?.textContent.includes('Continuing')", 'applied guidance has a reply-area placeholder before model output');
      await run(`window.dispatchEvent(new CustomEvent('cardbush:thinking', { detail: {
        sessionId: 'guide-session', turnId: 'guide-turn', id: 'guide-reasoning', phase: 'delta', delta: 'Checking the resource limits.'
      } })); void 0;`);
      await until("document.querySelector('.guidance-activity')?.textContent.includes('Checking the resource limits.')", 'reasoning is visible without assistant text');
      await pause(150);
      await fs.writeFile(path.join(root, 'tmp/chat-guidance-thinking-' + theme + '.png'), (await window.capturePage()).toPNG());
      await run('updateChat({ thinkingVisible: false });');
      await until("document.querySelector('.guidance-activity')?.textContent.includes('Continuing') && !document.querySelector('.guidance-activity').textContent.includes('Checking the resource limits.')", 'activity remains when reasoning display is disabled');
      await run('updateChat({ stopping: true });');
      await until("document.querySelector('.guidance-activity')?.textContent.includes('Stopping')", 'stopping remains visible');
      await run(`
        guidanceFixture.push({ id: 'guide-after', role: 'assistant', content: 'Continue with the plugin diagnosis.',
          sequence: 6, createdAt: '2026-09-15T10:00:06Z', turnId: 'guide-turn', conversationId: 'guide-session' });
        showGuidanceFixture();
      `);
      await until("document.querySelector('.message-row.streaming')?.textContent.includes('Continue with the plugin diagnosis.')", 'post-guidance response');
      assert.equal(await run("document.querySelectorAll('.guidance-activity,.guidance-delivery-status').length"), 0, 'real assistant output replaces the waiting row');
      const rows = await run("[...document.querySelectorAll('.message-row')].map(row => row.textContent)");
      assert.equal(rows.length, 4);
      assert.ok(rows[1].includes('First, measure the audio.') && rows[1].includes('The diagnosis is ready.'));
      assert.ok(rows[2].includes('Could the plugin be the cause?'));
      assert.ok(!rows[3].includes('First, measure the audio.') && !rows[3].includes('The diagnosis is ready.'));
      await pause(120);
      const appliedFrames = await run('cancelAnimationFrame(guidancePendingFrame); guidancePendingFrames');
      assert.ok(appliedFrames.length > 0 && appliedFrames.every(frame => frame.replyIndex === 1 && frame.guideIndex === 2 && frame.gap >= 0),
        'applying guidance must not move earlier output below it: ' + anchor + ' ' + JSON.stringify(appliedFrames));
      assert.equal(await run("document.querySelectorAll('.turn-artifacts-trigger').length"), 0,
        'applied guidance must not display a terminal changed-files summary');
      await fs.writeFile(path.join(root, 'tmp/chat-guidance-' + theme + '.png'), (await window.capturePage()).toPNG());
      for (const status of ['completed', 'stopped']) {
        await run(`showGuidanceFixture('${status}');`);
        await until("document.querySelectorAll('.turn-artifacts-trigger').length === 1", status + ' shows one turn summary');
        assert.equal(await run("document.querySelector('.turn-artifacts-trigger').closest('[data-message-id]').dataset.messageId"), 'guide-after');
        await pause(250);
        await run("if(document.querySelector('.turn-artifacts-trigger').getAttribute('aria-expanded')!=='true') document.querySelector('.turn-artifacts-trigger').click(); void 0");
        await until("document.querySelector('.turn-artifacts-popover')?.matches(':popover-open')", 'turn artifacts open');
        assert.ok(await run("document.querySelector('.turn-artifacts-popover').textContent.includes('analysis.ps1')"),
          'terminal summary includes file changes made before guidance');
      }
      await run("showGuidanceFixture('failed');");
      await pause();
      assert.equal(await run("document.querySelectorAll('.turn-artifacts-trigger').length"), 0);
    }
    await run(`
      guidanceFixture = guidanceFixture.filter(message => message.id !== 'guide-after').map(message => message.id === 'guide-user'
        ? { ...message, status: 'failed', metadata: { ...message.metadata, guidance_delivery: 'failed' } } : message);
      window.guideRetries = [];
      showGuidanceFixture('completed');
      updateChat({ guidanceAvailable: true, onRetryGuidance: async message => { guideRetries.push(message.id); } });
    `);
    await until("!!document.querySelector('.guidance-activity .guidance-retry-button')", 'failed guidance retains an agent-side retry');
    await run("document.querySelector('.guidance-retry-button').click(); void 0;");
    assert.deepEqual(await run('guideRetries'), ['guide-user']);
    assert.equal(await run("document.querySelectorAll('.user-bubble .guidance-retry-button').length"), 0);
  } finally {
    await run('cancelAnimationFrame(window.guidancePendingFrame); viewTheme = guidanceOriginal.theme; updateChat(guidanceOriginal.props);');
  }
  console.log('Guidance rendering passed: accepted and empty interrupted request anchors, stable frames in both themes, and completion/Stop-only file summaries.');
};
