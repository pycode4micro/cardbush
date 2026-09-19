const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`window.guidanceOriginal = { props: { ...chatProps }, theme: window.viewTheme }; void 0;`);
  try {
    for (const theme of ['theme-dark', 'theme-bright']) {
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
      await pause(100);
      await run(`
        guidanceFixture = guidanceFixture.map(message => message.id === 'guide-user'
          ? { ...message, status: 'queued', metadata: { ...message.metadata, guidance_delivery: 'queued' } }
          : message);
        guidanceFixture.push(guidanceToolMessage);
        showGuidanceFixture();
      `);
      await until("!!document.querySelector('[data-message-id=guide-seal]')", 'new tool round while guidance is queued');
      await pause(200);
      const pendingFrames = await run('cancelAnimationFrame(guidancePendingFrame); guidancePendingFrames');
      assert.ok(pendingFrames.length > 0);
      assert.ok(pendingFrames.every(frame => frame.replyIndex === 1 && frame.guideIndex === 2 &&
        frame.gap >= 0 && frame.gap < 80),
      'queued guidance stays below prior output in every rendered frame: ' + JSON.stringify(pendingFrames));
      await fs.writeFile(path.join(root, 'tmp/chat-guidance-queued-' + theme + '.png'), (await window.capturePage()).toPNG());
      await run(`
        guidanceFixture = views.applyAssistantSegmentBoundary({ 'guide-session': guidanceFixture },
          'guide-session', 'guide-diagnosis', { kind: 'loop_transition', reason: 'turn_guidance_applied',
            messageId: '', turnId: 'guide-turn', previousAssistantMessageId: 'guide-seal',
            guidanceMessageId: 'guide-user', sequence: 5 })['guide-session'];
        guidanceFixture.push({ id: 'guide-after', role: 'assistant', content: 'Continue with the plugin diagnosis.',
          sequence: 6, createdAt: '2026-09-15T10:00:06Z', turnId: 'guide-turn', conversationId: 'guide-session' });
        showGuidanceFixture();
      `);
      await until("document.querySelector('.guidance-delivery-status')?.textContent === 'Sent as guidance'", 'guidance applied');
      await until("document.querySelector('.message-row.streaming')?.textContent.includes('Continue with the plugin diagnosis.')", 'post-guidance response');
      const rows = await run("[...document.querySelectorAll('.message-row')].map(row => row.textContent)");
      assert.equal(rows.length, 4);
      assert.ok(rows[1].includes('First, measure the audio.') && rows[1].includes('The diagnosis is ready.'));
      assert.ok(rows[2].includes('Could the plugin be the cause?'));
      assert.ok(!rows[3].includes('First, measure the audio.') && !rows[3].includes('The diagnosis is ready.'));
      assert.equal(await run("document.querySelectorAll('.assistant-changed-files-summary').length"), 0,
        'applied guidance must not display a terminal changed-files summary');
      await fs.writeFile(path.join(root, 'tmp/chat-guidance-' + theme + '.png'), (await window.capturePage()).toPNG());
      for (const status of ['completed', 'stopped']) {
        await run(`showGuidanceFixture('${status}');`);
        await until("document.querySelectorAll('.assistant-changed-files-summary').length === 1", status + ' shows one turn summary');
        assert.equal(await run("document.querySelector('.assistant-changed-files-summary').closest('[data-message-id]').dataset.messageId"), 'guide-after');
        assert.ok(await run("document.querySelector('.assistant-changed-files-summary').textContent.includes('analysis.ps1')"),
          'terminal summary includes file changes made before guidance');
      }
      await run("showGuidanceFixture('failed');");
      await pause();
      assert.equal(await run("document.querySelectorAll('.assistant-changed-files-summary').length"), 0);
    }
  } finally {
    await run('cancelAnimationFrame(window.guidancePendingFrame); viewTheme = guidanceOriginal.theme; updateChat(guidanceOriginal.props);');
  }
  console.log('Guidance rendering passed: chronological groups, both themes, and completion/Stop-only file summaries.');
};
