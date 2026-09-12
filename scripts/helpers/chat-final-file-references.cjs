const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    window.referenceInspections = [];
    window.originalInspectReference = cardbushDesktop.inspectLocalReference;
    cardbushDesktop.inspectLocalReference = async path => {
      referenceInspections.push(path);
      await new Promise(resolve => setTimeout(resolve, 60));
      return { path, name: path.split('/').pop(), kind: path.endsWith('.md') ? 'file' : 'folder' };
    };
    window.referenceContent = '检查 [项目目录](D:/final-reference-test/project)，然后读取 \`src/facts.md\`，路径 D:/final-reference-test/bare，外链 [文档](https://example.com/docs)。';
    window.referenceMessage = { id: 'ref-message', conversationId: 'ref-session', turnId: 'ref-turn',
      role: 'assistant', status: 'streaming', content: referenceContent };
    window.renderReferenceMessage = (sending = true) => renderView(
      h(views.MessageFileReferenceScope, { workspaceRoot: 'D:/final-reference-test' },
        h(views.MessageBubble, { message: referenceMessage, language: 'zh', sending,
          activeTurnId: sending ? 'ref-turn' : '', activeAssistantMessageId: sending ? 'ref-message' : '' })));
    renderReferenceMessage();
  `);
  await until("document.querySelector('.message-row.streaming .markdown-content')?.textContent.includes('项目目录')", 'streaming file references');
  for (let i = 0; i < 6; i++) {
    await run("referenceMessage = { ...referenceMessage, content: referenceMessage.content + ' 继续检查。' }; renderReferenceMessage();");
    await pause(40);
    assert.equal(await run("document.querySelectorAll('.local-file-reference, .local-file-reference-unavailable').length"), 0, 'intermediate narration has no rich path nodes');
  }
  assert.deepEqual(await run('referenceInspections'), [], 'streaming paths trigger no filesystem inspections');
  assert.equal(await run("document.querySelector('.markdown-content code')?.textContent"), 'src/facts.md', 'inline code keeps its authored path');
  assert.equal(await run("document.querySelector('.markdown-content a')?.getAttribute('href')"), 'https://example.com/docs', 'ordinary web links remain available');
  await run("referenceMessage = { ...referenceMessage, status: 'completed', metadata: { transcript_kind: 'assistant_loop' } }; renderReferenceMessage(false)");
  await pause();
  await run("document.querySelector('.assistant-completed-summary').click()");
  await until("document.querySelector('.assistant-completed-content')?.textContent.includes('项目目录')", 'expanded intermediate round');
  assert.deepEqual(await run('referenceInspections'), [], 'sealed intermediate rounds never start resolving paths');
  for (const status of ['failed', 'stopped']) {
    await run(`referenceMessage = { ...referenceMessage, status: ${JSON.stringify(status)}, metadata: {} }; renderReferenceMessage(false)`);
    await pause();
    assert.deepEqual(await run('referenceInspections'), [], `${status} rounds remain textual`);
  }
  await run("referenceMessage = { ...referenceMessage, status: 'completed', metadata: { transcript_kind: 'assistant_final' } }; renderReferenceMessage(false)");
  await until("document.querySelectorAll('.assistant-final-answer .local-file-reference').length === 3", 'committed final answer resolves file and folder paths');
  assert.deepEqual((await run('referenceInspections')).sort(), ['D:/final-reference-test/project', 'D:/final-reference-test/src/facts.md', 'D:/final-reference-test/bare'].sort());
  await run("window.retainedFinalFileLink = document.querySelector('.assistant-final-answer .local-file-reference'); void 0");
  for (let i = 0; i < 4; i++) {
    await run("referenceMessage = { ...referenceMessage, content: referenceMessage.content + ' 补充说明。' }; renderReferenceMessage(false)");
    await pause(40);
    assert.equal(await run("retainedFinalFileLink === document.querySelector('.assistant-final-answer .local-file-reference')"), true, 'text updates preserve the resolved path component and DOM');
  }
  await run("referenceMessage = { ...referenceMessage, role: 'user', metadata: {} }; renderReferenceMessage(false)");
  await until("document.querySelector('.user-bubble .local-file-reference') !== null", 'authored user references remain interactive');
  await run("cardbushDesktop.inspectLocalReference = originalInspectReference; renderView(null)");
  console.log('Final file references passed: no streaming/loop/error inspections, final paths resolved once, stable DOM, user and web references retained.');
};
