const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testAgentConversationLayout({ run, until, pause, win, root }) {
  // The shared rail intentionally hides below a 940px reading pane. Measure its
  // complete tick list at a supported width before exercising narrow layouts.
  win.setSize(1420, 860);
  await run(`window.layoutBaseSnapshot = structuredClone(snapshots.b[0]);
    const history = Array.from({length: 24}, (_, index) => ({
      turnId: 'history-' + index, turnSequence: index + 1, status: 'completed', reason: 'done',
      createdAt: '2026-09-21T01:00:00Z', completedAt: '2026-09-21T01:00:10Z',
      messages: [
        {messageId: 'history-user-' + index, message: {role: 'user', content: '远程历史请求 ' + index}},
        {messageId: 'history-answer-' + index, message: {role: 'assistant', content: '远程历史回复 ' + index + '\\n\\n' + '检查滚动与排版。'.repeat(120)}}
      ].map((message, messageIndex) => ({...message, turnId: 'history-' + index, turnSequence: index + 1, messageIndex, createdAt: '2026-09-21T01:00:00Z'}))
    }));
    snapshots.b[0].turns = [...history, ...layoutBaseSnapshot.turns.map(turn => ({...turn, turnSequence: 25, messages: turn.messages.map(message => ({...message, turnSequence:25}))}))];
    snapshots.b[0].revision++;
    window.dispatchEvent(new CustomEvent('cardbush:agent-session-updated', {detail: {connectionId:'b',sessionId:'same-session'}}));
    window.agentGeometry = () => {
      const scroller = document.querySelector('.agent-chat .message-list');
      const last = [...scroller.querySelectorAll('[data-message-role=assistant]')].at(-1);
      const surface = document.querySelector('.agent-chat .composer-surface');
      const dock = document.querySelector('.agent-chat .composer-dock');
      return {top: scroller.scrollTop, bottom: scroller.scrollHeight - scroller.clientHeight,
        message: last.querySelector('.message-row').getBoundingClientRect().toJSON(), composer: surface.getBoundingClientRect().toJSON(),
        contentTop: dock.firstElementChild.getBoundingClientRect().top,
        background: getComputedStyle(dock).backgroundImage};
    }; undefined;`);
  await until("document.querySelectorAll('.agent-chat .quick-context-tick').length === 25", 'remote turn rail');
  assert.equal(await run("document.querySelector('.sidebar-scroll').textContent.indexOf('置顶') < document.querySelector('.sidebar-scroll').textContent.indexOf('Agents')"), true, 'Pinned precedes Agents');
  await pause(350);
  await run("window.retainedAgentScroller=document.querySelector('.agent-chat .message-list');retainedAgentScroller.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1000}));retainedAgentScroller.scrollTop=retainedAgentScroller.scrollHeight;undefined;");
  await pause(350);
  const bottom = await run('agentGeometry()');
  assert.ok(Math.abs(bottom.top - bottom.bottom) < 2, 'can manually reach the absolute bottom');
  const jobsBefore = await run("calls.filter(c=>c.id==='b' && c.operation==='chat.jobs').length");
  await until(`calls.filter(c=>c.id==='b' && c.operation==='chat.jobs').length >= ${jobsBefore + 2}`, 'two idle refreshes', 7000);
  const afterPoll = await run('agentGeometry()');
  assert.ok(Math.abs(afterPoll.top - afterPoll.bottom) < 2, 'polling cannot pull the viewport off the bottom');
  assert.equal(await run("document.querySelector('.agent-chat .message-list') === retainedAgentScroller"), true, 'polling preserves the shared scroller');

  await run("retainedAgentScroller.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-1000}));retainedAgentScroller.scrollTop=retainedAgentScroller.scrollHeight/2;undefined;");
  await pause(350);
  const readingTop = await run('agentGeometry().top');
  await pause(2100);
  assert.ok(Math.abs(await run('agentGeometry().top') - readingTop) < 2, 'polling preserves a manually chosen reading position');
  await until("!!document.querySelector('.agent-chat .scroll-bottom:not(.hidden)')", 'shared jump to bottom');
  await run("document.querySelector('.agent-chat .scroll-bottom').click()");
  await pause(700);
  async function assertReadable(label) {
    const geometry = await run('agentGeometry()');
    assert.ok(geometry.message.bottom <= geometry.contentTop + 2, label + ': final message clears the composer');
    assert.ok(Math.abs(geometry.message.left - geometry.composer.left) < 2, label + ': left edges align ' + JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.message.right - geometry.composer.right) < 2, label + ': right edges align ' + JSON.stringify(geometry));
    assert.ok(geometry.background.includes('linear-gradient') && geometry.background.includes('rgba'), label + ': shared transparent fade');
  }
  await assertReadable('wide');
  await run("document.querySelector('.agent-chat .quick-context-tick').click()");
  await until("document.querySelector('.quick-context-panel.detail')?.textContent.includes('远程历史回复 0')", 'remote full-turn preview');
  assert.equal(await run("!!document.querySelector('.quick-context-request-list')"), false, 'related-request search stays removed');
  await run("[...document.querySelectorAll('.quick-context-panel footer button')].find(b=>b.textContent.includes('复制')).click()");
  await until("copied.some(text=>text.startsWith('远程历史回复 0'))", 'remote reply copied');
  await run("[...document.querySelectorAll('.quick-context-panel footer button')].find(b=>b.textContent.includes('跳转')).click()");
  await until("!document.querySelector('.quick-context-panel') && retainedAgentScroller.scrollTop < 400", 'jump to remote historical turn');
  await run("document.querySelector('.agent-chat .scroll-bottom').click()");
  await pause(700);
  win.setSize(620, 760);
  await run("document.querySelector('.fixture-shell').classList.add('narrow')");
  await pause(500);
  await run("document.querySelector('.agent-chat .scroll-bottom').click()");
  await pause(500);
  await assertReadable('narrow');
  assert.ok(await run('document.documentElement.scrollWidth <= innerWidth'), 'no narrow overflow');
  win.setSize(1420, 860);
  await run("document.querySelector('.fixture-shell').classList.remove('narrow')");
  await pause(500);
  await run("document.querySelector('.agent-chat .scroll-bottom').click()");
  await pause(500);
  await assertReadable('resized');
  fs.writeFileSync(path.join(root, 'tmp/agents-chat-shared-layout.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(await run("calls.some(c=>c.operation==='local-runtime')"), false, 'remote rail must not fetch local history');
  await run("snapshots.b[0]={...layoutBaseSnapshot,revision:snapshots.b[0].revision+1};window.dispatchEvent(new CustomEvent('cardbush:agent-session-updated',{detail:{connectionId:'b',sessionId:'same-session'}}));undefined;");
  await until("document.querySelectorAll('.agent-chat .quick-context-tick').length === 1", 'restore review fixture');
};
