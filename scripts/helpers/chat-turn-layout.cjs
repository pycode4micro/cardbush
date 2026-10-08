const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.layoutOriginal = { ...chatProps };
    window.layoutMotionPreference = document.documentElement.dataset.motionPreference;
    document.documentElement.dataset.motionPreference = 'off';
    window.goalCancelled = 0;
    window.turnReviews = [];
    window.layoutTool = { id: 'layout-tool', name: 'terminal_exec', state: 'completed', success: true,
      summary: '检查布局', output: 'layout verification passed', durationMs: 250,
      createdAt: '2026-09-28T05:00:02Z', metadata: { displayTitle: '检查布局' } };
    window.layoutPlan = { protocol: 'bush.task_plan.v1', planId: 'layout-plan', active: true,
      nodes: [{ step: '整理会话布局', status: 'completed' }, { step: '验证队列位置', status: 'in_progress' }] };
    window.layoutHistory = { id: 'layout-history', conversationId: 'layout-session', turnId: 'layout-turn',
      role: 'assistant', status: 'completed', content: '检查当前布局。', createdAt: '2026-09-28T05:00:01Z',
      toolExecutions: [layoutTool], taskPlan: layoutPlan };
    window.layoutAssistant = { id: 'layout-assistant', conversationId: 'layout-session', turnId: 'layout-turn',
      role: 'assistant', status: 'streaming', content: '正在调整布局。', createdAt: '2026-09-28T05:00:04Z',
      taskPlan: layoutPlan, loopHistory: [layoutHistory] };
    window.layoutUser = { id: 'layout-user', role: 'user', turnId: 'layout-turn', content: '优化会话布局', createdAt: '2026-09-28T05:00:00Z' };
    window.layoutGoal = { protocol: 'bush.goal.v1', goalId: 'layout-goal', sessionId: 'layout-session',
      objective: '完成会话布局优化', status: 'active', statusReason: '', consumedTokens: 100, revision: 1,
      createdAt: '2026-09-28T05:00:01Z', updatedAt: '2026-09-28T05:00:02Z' };
    updateChat({ activeConversationId: 'layout-session', conversation: { id: 'layout-session', title: '会话布局' },
      language: 'zh', messages: [layoutUser, layoutAssistant], sending: true, activeTurnId: 'layout-turn',
      activeGoal: layoutGoal, thinkingVisible: true, queuedMessageCount: 0, queuedMessages: [],
      changeReports: [{ id: 'layout-change', messageId: 'layout-assistant', turnId: 'layout-turn', fileCount: 1,
        additions: 8, deletions: 3, files: [{ path: 'src/layout.ts', additions: 8, deletions: 3, diff: '', lines: [] }] }],
      onCancelGoal: async () => { goalCancelled++; }, onOpenChangeReview: (...args) => turnReviews.push(args) });
  `);
  await until("!!document.querySelector('.message-list .runtime-plan-detail')", 'live plan belongs to the current turn');
  assert.equal(await run("getComputedStyle(document.querySelector('.runtime-plan-spinner')).animationName"), 'cardbush-spin', 'live plan spinner no longer requires the removed processing panel');
  assert.equal(await run("getComputedStyle(document.querySelector('.runtime-plan-detail .completed > svg')).animationName"), 'none', 'completed steps do not rotate');
  assert.equal(await run("getComputedStyle(document.querySelector('.assistant-thinking-label')).backgroundImage"), 'none', 'plan is the only animated activity indicator');
  assert.equal(await run("getComputedStyle(document.querySelector('.assistant-thinking-model.fallback svg')).animationName"), 'none', 'the fallback thinking icon also stays still while a plan is visible');
  const planRotation = await run("getComputedStyle(document.querySelector('.runtime-plan-spinner')).transform");
  await pause(130);
  assert.notEqual(await run("getComputedStyle(document.querySelector('.runtime-plan-spinner')).transform"), planRotation, 'plan circle visibly rotates over time');
  assert.equal(await run("document.querySelector('.message-row.assistant .message-actions')"), null,
    'running loops mount no copy, retry or feedback actions');
  assert.equal(await run("document.querySelector('.composer-runtime-rail')"), null, 'empty queue leaves no status rail');
  await run("document.querySelector('.runtime-goal-cancel').click(); document.querySelector('.turn-change-review').click()");
  assert.equal(await run('goalCancelled'), 1);
  assert.equal((await run('turnReviews'))[0][1], 'layout-turn', 'review targets this turn');
  await run(`window.layoutThinking = document.querySelector('.assistant-active-transcript > .turn-thinking-detail');
    window.sendLayoutThinking = (delta, overrides = {}) => window.dispatchEvent(new CustomEvent('cardbush:thinking', { detail: {
      sessionId: 'layout-session', turnId: 'layout-turn', generationId: 'layout-thinking', phase: 'delta',
      delta, createdAt: '2026-09-28T05:00:05Z', ...overrides } })); null;`);
  assert.equal(await run("layoutThinking.querySelector('summary').textContent.trim()"), '思考中');
  const thinkingHeight = await run("layoutThinking.getBoundingClientRect().height");
  await run("sendLayoutThinking('核对记录和队列的归属')");
  await until("!!layoutThinking.querySelector('small')", 'thinking preview replaces the existing transcript placeholder');
  assert.equal(await run("document.querySelectorAll('.message-list .turn-thinking-detail').length"), 1, 'one thinking entry only');
  assert.equal(await run("document.querySelector('.turn-runtime-details .turn-thinking-detail')"), null, 'progress area has no duplicate thinking entry');
  assert.equal(await run("layoutThinking === document.querySelector('.assistant-active-transcript > .turn-thinking-detail')"), true, 'reasoning reuses the original tail slot');
  assert.ok(Math.abs(await run("layoutThinking.getBoundingClientRect().height") - thinkingHeight) < 1, 'collapsed preview keeps the same height');
  assert.equal(await run("document.querySelector('.composer-dock .turn-thinking-detail')"), null);
  await run("layoutThinking.querySelector('summary').click()");
  await until("layoutThinking.open && !!layoutThinking.querySelector('.turn-thinking-content')", 'thinking expands at the original position');
  await run("sendLayoutThinking('，保持展开内容实时更新。'); sendLayoutThinking('其他会话不可见', { sessionId: 'other' }); sendLayoutThinking('旧轮次不可见', { turnId: 'old-turn' })");
  await until("layoutThinking.querySelector('.turn-thinking-content').textContent.endsWith('实时更新。')", 'expanded reasoning receives streamed content');
  assert.equal(await run("layoutThinking.querySelector('.turn-thinking-content').textContent"), '核对记录和队列的归属，保持展开内容实时更新。', 'other sessions and turns cannot overwrite live reasoning');
  // The isolated ChatPanel has no main-stage ancestor providing this token.
  await run("document.querySelector('.chat-panel').style.setProperty('--chat-track-width', '780px')");
  for (const width of [1200, 900, 440, 330]) {
    await run(`document.querySelector('.chat-panel').style.width = '${width}px'`);
    await pause(150);
    assert.ok(await run("(() => { const el = document.querySelector('.turn-runtime-details'); return el.scrollWidth <= el.clientWidth + 1; })()"), width + 'px progress fits without horizontal overflow');
    assert.ok(await run("layoutThinking.scrollWidth <= layoutThinking.clientWidth + 1"), width + 'px thinking fits without horizontal overflow');
    const alignment = await run(`(() => {
      const details = document.querySelector('.turn-runtime-details');
      const row = details.parentElement.querySelector('.message-row.assistant').getBoundingClientRect();
      const progress = details.getBoundingClientRect();
      const review = details.querySelector('.turn-change-review').getBoundingClientRect();
      return { left: progress.left - row.left, right: progress.right - row.right,
        reviewLeft: review.left - row.left, reviewRight: review.right - row.right };
    })()`);
    assert.ok(Math.abs(alignment.left) < 1 && Math.abs(alignment.right) < 1,
      `${width}px progress shares the message reading track: ${JSON.stringify(alignment)}`);
    assert.ok(Math.abs(alignment.reviewLeft) < 1 && alignment.reviewRight <= 1,
      `${width}px changed-files entry stays aligned inside the conversation`);
  }
  await run("document.querySelector('.chat-panel').style.width = ''; document.querySelector('.chat-panel').style.removeProperty('--chat-track-width')");
  await pause(150);
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'turn-layout-thinking.png'), (await window.webContents.capturePage()).toPNG());
  await run("sendLayoutThinking('', { phase: 'end' })");
  await until("!layoutThinking.open && !layoutThinking.querySelector('.turn-thinking-content') && !layoutThinking.querySelector('small')", 'reasoning end restores compact activity in the same slot');
  await run("updateChat({ thinkingVisible: false })");
  await pause();
  await run("sendLayoutThinking('关闭思考展示后不可见')");
  await pause(150);
  assert.equal(await run("layoutThinking.querySelector('small')"), null, 'hidden reasoning remains hidden');
  assert.equal(await run("layoutThinking.querySelector('summary').textContent.trim()"), '思考中', 'activity remains visible when reasoning is disabled');
  await run("updateChat({ thinkingVisible: true })");
  await pause();
  await run("sendLayoutThinking('新思考内容', { generationId: 'layout-thinking-next' })");
  await until("!!layoutThinking.querySelector('small')", 'reasoning can be enabled again');
  await run(`updateChat({ queuedMessages: [{ id: 'layout-q', text: '随后检查窄屏布局', createdAt: '2026-09-28T05:00:06Z' }],
    queuedMessageCount: 1, queuedMessagePreview: '随后检查窄屏布局' });`);
  await until("!!document.querySelector('.composer-runtime-screen.queue')", 'rail is exclusively queue');
  const composerTop = () => run("document.querySelector('.composer-dock').getBoundingClientRect().top");
  const top = await composerTop();
  await run("document.querySelector('.composer-runtime-screen.queue').click()");
  await until("!!document.querySelector('.queue-context-panel')", 'queue expands');
  await pause(220);
  assert.ok(Math.abs(await composerTop() - top) < 1, 'expanding queue leaves input position unchanged');
  assert.equal(await run("getComputedStyle(document.querySelector('.runtime-queue-list')).scrollbarGutter"), 'stable');
  await run("document.querySelector('.queue-context-panel header button').click()");
  await run(`window.completedLayoutPlan = { ...layoutPlan, nodes: layoutPlan.nodes.map(node => ({ ...node, status: 'completed' })) };
    updateChat({ messages: [layoutUser, { ...layoutAssistant, taskPlan: completedLayoutPlan }] });`);
  await until("!document.querySelector('.runtime-plan-detail')", 'all completed steps hide the live board before the turn finishes');
  assert.equal(await run("getComputedStyle(document.querySelector('.assistant-thinking-label')).animationName"), 'thinking-mask-sweep', 'finishing the plan restores the thinking mask while work continues');
  assert.ok(await run("!!document.querySelector('.runtime-goal-detail') && !!document.querySelector('.turn-change-review')"),
    'plan completion preserves the goal and changed-files entry');
  await run("updateChat({ activeGoal: null, changeReports: [] })");
  await until("!document.querySelector('.turn-runtime-details')", 'a completed plan alone leaves no empty progress container');
  await run("updateChat({ messages: [layoutUser, layoutAssistant] })");
  await until("!!document.querySelector('.runtime-plan-detail')", 'new unfinished work restores the plan board');
  assert.equal(await run("getComputedStyle(document.querySelector('.assistant-thinking-label')).animationName"), 'none', 'restoring the plan stops the thinking mask immediately');
  await run(`layoutAssistant = { ...layoutAssistant, status: 'completed', content: '会话布局已优化。',
    taskPlan: undefined, loopHistory: [{ ...layoutHistory, taskPlan: { ...completedLayoutPlan, active: false } }],
    metadata: { cardbush_turn_started_at: '2026-09-28T05:00:00Z',
      completed_at: '2026-09-28T05:01:24Z', cardbush_turn_duration_ms: 84000 } };
    updateChat({ messages: [layoutUser, layoutAssistant], sending: false, activeTurnId: '', activeGoal: null,
      queuedMessages: [], queuedMessageCount: 0 });`);
  await until("!!document.querySelector('.assistant-completed-summary')", 'completed history is attached to reply');
  await until("getComputedStyle(document.querySelector('.message-row.assistant .message-actions')).opacity === '1'",
    'latest completed reply reveals its actions without hover');
  assert.equal(await run("document.querySelectorAll('.message-row.assistant .message-actions button').length"), 4);
  await run("document.querySelector('.message-row.assistant .feedback-up').click()");
  assert.equal(await run("document.querySelector('.message-row.assistant .feedback-up').getAttribute('aria-pressed')"), 'true');
  assert.equal(await run("document.querySelector('.turn-thinking-detail')"), null, 'completed turns leave no live thinking entry');
  assert.equal(await run("document.querySelector('.assistant-completed-summary').getAttribute('aria-expanded')"), 'false');
  assert.equal(await run("document.querySelector('.assistant-completed-summary').textContent"), '已处理 1m 24s',
    'compact disclosure restores the completed turn duration without a history prefix');
  await run("updateChat({ language: 'en' })");
  await until("document.querySelector('.assistant-completed-summary').textContent === 'Processed 1m 24s'",
    'completed duration follows the interface language');
  await run("updateChat({ language: 'zh' })");
  await until("document.querySelector('.assistant-completed-summary').textContent === '已处理 1m 24s'",
    'completed duration is frozen across rerenders');
  assert.equal(await run("document.querySelector('.assistant-loop-history')"), null, 'collapsed history mounts no tool detail');
  assert.equal(await run("document.querySelector('.assistant-final-answer').textContent"), '会话布局已优化。');
  assert.equal(await run("Boolean(document.querySelector('.assistant-completed-summary').compareDocumentPosition(document.querySelector('.assistant-final-answer')) & Node.DOCUMENT_POSITION_FOLLOWING)"), true);
  await run("document.querySelector('.assistant-completed-summary').click()");
  await until("!!document.querySelector('.assistant-loop-history .tool-execution-block')", 'history opens in place');
  assert.equal(await run("document.querySelector('.assistant-loop-history-timestamp, .assistant-loop-history .tool-execution-status')"), null,
    'history omits per-entry timestamps and ordinary tool statuses');
  assert.equal(await run("document.querySelectorAll('.assistant-final-answer').length"), 1, 'opening history never duplicates the final answer');
  assert.ok(await run("document.querySelector('.assistant-loop-history').textContent.includes('整理会话布局')"), 'plan survives on historical segment');
  await run("updateChat({ title: 'Updated title' })");
  await pause();
  assert.equal(await run("document.querySelector('.assistant-completed-summary').getAttribute('aria-expanded')"), 'true', 'unrelated updates keep history open');
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'turn-layout-history.png'), (await window.webContents.capturePage()).toPNG());
  await run(`window.nextLayoutUser = { ...layoutUser, id: 'layout-next-user', turnId: 'layout-next', content: '继续检查' };
    window.nextLayoutAssistant = { id: 'layout-next-assistant', conversationId: 'layout-session', turnId: 'layout-next',
      role: 'assistant', status: 'streaming', content: '正在检查。' };
    updateChat({ messages: [layoutUser, layoutAssistant, nextLayoutUser, nextLayoutAssistant], selectedModel: 'gpt-6-astra', sending: true, activeTurnId: 'layout-next' });`);
  await until("!!document.querySelector('[data-message-id=layout-next-assistant] .assistant-thinking-process')", 'new turn starts');
  await run("window.maskLabel=document.querySelector('[data-message-id=layout-next-assistant] .assistant-thinking-label');window.maskAnimation=maskLabel.getAnimations()[0];maskAnimation.pause();maskAnimation.currentTime=1100;undefined;");
  assert.equal(await run("getComputedStyle(maskLabel).animationName"), 'thinking-mask-sweep', 'a new planless turn shows the running text mask');
  assert.equal(await run("getComputedStyle(maskLabel).getPropertyValue('--thinking-mask-color').trim()"), '#000', 'dark theme uses a black mask over light text');
  const positions = await run("maskAnimation.effect.getKeyframes().map(frame=>frame.backgroundPositionX)");
  assert.deepEqual(positions, ['100%', '0%'], 'the enlarged mask moves through the text from left to right');
  await run("maskLabel.scrollIntoView({block:'center',behavior:'instant'});undefined;");
  await pause(180);
  fs.writeFileSync(path.join(root, 'tmp', 'turn-thinking-mask-dark.png'), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('.app').classList.replace('theme-dark','theme-bright');undefined;");
  assert.equal(await run("getComputedStyle(maskLabel).getPropertyValue('--thinking-mask-color').trim()"), '#fff', 'light theme uses a light mask over dark text');
  await pause(100);
  fs.writeFileSync(path.join(root, 'tmp', 'turn-thinking-mask-bright.png'), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('.app').classList.replace('theme-bright','theme-dark');maskAnimation.play();undefined;");
  assert.equal(await run("document.querySelector('[data-message-id=layout-next-assistant] .message-actions')"), null);
  await until("getComputedStyle(document.querySelector('[data-message-id=layout-assistant] .message-actions')).opacity === '0'",
    'previous turn actions return to hover-only when new work starts');
  await run("document.querySelector('.app').classList.add('has-custom-background')");
  assert.equal(await run("getComputedStyle(maskLabel).animationName"), 'thinking-mask-sweep', 'custom backgrounds retain the same planless running feedback');
  assert.equal(await run("getComputedStyle(document.querySelector('[data-message-id=layout-assistant] .message-actions')).opacity"), '0',
    'custom backgrounds do not force older actions visible');
  await run("document.querySelector('[data-message-id=layout-assistant] .message-actions button').focus()");
  await until("getComputedStyle(document.querySelector('[data-message-id=layout-assistant] .message-actions')).opacity === '1'",
    'keyboard focus reveals older actions');
  await run("document.activeElement.blur(); document.querySelector('.app').classList.remove('has-custom-background')");
  await run(`updateChat({ messages: [layoutUser, layoutAssistant, nextLayoutUser,
      { ...nextLayoutAssistant, status: 'completed', content: '检查完成。' }], sending: false, activeTurnId: '' });`);
  await until("document.querySelector('[data-message-id=layout-next-assistant] .message-actions') && getComputedStyle(document.querySelector('[data-message-id=layout-next-assistant] .message-actions')).opacity === '1'",
    'finishing the next turn reveals its actions');
  assert.equal(await run("document.querySelectorAll('.message-row.assistant .message-actions.latest').length"), 1,
    'only the newest completed task keeps actions visible');
  await until("getComputedStyle(document.querySelector('[data-message-id=layout-assistant] .message-actions')).opacity === '0'",
    'older actions fade out after keyboard focus leaves');
  await run("updateChat({ activeConversationId: 'layout-other', messages: [], activeGoal: null })");
  await until("!document.querySelector('.turn-runtime-details') && !document.querySelector('.composer-runtime-rail')", 'switching sessions clears live state');
  await run("if (layoutMotionPreference === undefined) delete document.documentElement.dataset.motionPreference; else document.documentElement.dataset.motionPreference=layoutMotionPreference;updateChat(layoutOriginal);");
  console.log('Turn layout passed: live plan rotation, exclusive theme-aware thinking masks, inline history, archived plans, live reasoning, goal cancellation, scoped review, queue-only rail and stable input position.');
};
