const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    window.previousSaved = { props: { ...chatProps }, updateChat, settings: localStorage.getItem(views.keyboardShortcutsStorageKey) };
    views.saveKeyboardShortcuts({});
    window.previousTargets = [{ id: 'previous-a' }, { id: 'previous-b' }, { id: 'previous-c' }];
    window.previousPrepared = [{ id: 'previous-draft' }];
    window.previousEnabled = true; window.previousOpened = []; window.previousSends = 0;
    window.previousDrafts = { 'previous-a': 'A 的草稿', 'previous-b': 'B 的草稿', 'previous-c': '', 'previous-draft': '尚未发送的新会话' };
    window.previousMessages = Object.fromEntries([...previousTargets, ...previousPrepared].map(({ id }) => [id,
      Array.from({ length: id === 'previous-draft' ? 0 : 18 }, (_, i) => ({ id: id + '-' + i, role: i % 2 ? 'assistant' : 'user',
        content: ('Conversation ' + id + ' message ' + i + '.\\n\\n').repeat(5), turnId: id + '-turn-' + i }))]));
    window.selectPreviousFixture = id => updateChat({ activeConversationId: id, messages: previousMessages[id], draft: previousDrafts[id],
      sending: id === 'previous-a', activeTurnId: id === 'previous-a' ? id + '-turn-17' : '', loading: false, historyLoading: false });
    window.PreviousHarness = () => {
      views.usePreviousConversationShortcut({ activeConversationId: chatProps.activeConversationId,
        conversations: previousTargets, preparedConversations: previousPrepared, enabled: previousEnabled,
        onOpenConversation: id => { previousOpened.push(id); selectPreviousFixture(id); } });
      const committedTargets = previousTargets, committedEnabled = previousEnabled;
      React.useLayoutEffect(() => {
        window.previousCommittedTargets = committedTargets;
        window.previousCommittedEnabled = committedEnabled;
      });
      return h(views.ChatPanel, chatProps);
    };
    window.updateChat = patch => { Object.assign(chatProps, patch); renderView(h(PreviousHarness)); };
    Object.assign(chatProps, { onDraftChange: draft => { previousDrafts[chatProps.activeConversationId] = draft; updateChat({ draft }); },
      onSend: async () => { previousSends++; }, onCancel: async () => { previousSends++; } });
    window.previousKey = (options = {}, selector = '[data-composer-input]') => {
      const node = document.querySelector(selector); node.focus();
      const event = new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true, ...options });
      node.dispatchEvent(event); return event.defaultPrevented;
    };
    selectPreviousFixture('previous-a');
  `);
  const selected = id => until(`chatProps.activeConversationId === ${JSON.stringify(id)} && document.querySelector('[data-composer-input]')?.value === previousDrafts[${JSON.stringify(id)}] && ${id === 'previous-draft' ? "!!document.querySelector('.welcome-composer')" : `!!document.querySelector('[data-message-id="${id}-17"]')`}`, 'selected ' + id);
  try {
    await selected('previous-a');
    assert.equal(await run('previousKey()'), true);
    assert.deepEqual(await run('previousOpened'), [], 'one visited conversation is a quiet no-op');
    await pause(500);
    await run(`{
      const list = document.querySelector('.message-list');
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true })); list.scrollTop = 900;
    }`);
    await pause(100);
    await run(`{
      const list = document.querySelector('.message-list');
      const item = [...list.querySelectorAll('.message-list-item')].find(node => node.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      window.previousReading = { id: item.dataset.messageId, offset: item.getBoundingClientRect().top - list.getBoundingClientRect().top };
      selectPreviousFixture('previous-b');
    }`);
    await selected('previous-b');
    await run('previousTargets = [previousTargets[2], previousTargets[1], previousTargets[0]]; updateChat({})');
    await run('previousKey()');
    await selected('previous-a');
    assert.equal(await run('document.querySelector("[data-composer-input]").value'), 'A 的草稿');
    await until(`(() => { const list = document.querySelector('.message-list'); const item = list.querySelector('[data-message-id="' + previousReading.id + '"]');
      return Math.abs(item.getBoundingClientRect().top - list.getBoundingClientRect().top - previousReading.offset) < 2; })()`, 'reading position restored');
    for (let i = 0; i < 5; i++) assert.equal(await run('previousKey({ repeat: true })'), true);
    assert.equal(await run('chatProps.activeConversationId'), 'previous-a', 'holding the shortcut never toggles repeatedly');
    await run('previousKey()'); await selected('previous-b');
    assert.equal(await run('document.querySelector("[data-composer-input]").value'), 'B 的草稿');
    assert.deepEqual(await run('previousOpened'), ['previous-a', 'previous-b'], 'switches by visits, not background sorting');

    // An open slash menu must not consume Ctrl+Tab as its own confirmation.
    await run(`{ const input = document.querySelector('[data-composer-input]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '/');
      input.setSelectionRange(1, 1); input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    await until('!!document.querySelector(".composer-command-palette")', 'slash menu open');
    await run('previousKey()'); await selected('previous-a');
    assert.equal(await run('previousDrafts["previous-b"]'), '/', 'switching cannot select a command or modify the saved draft');
    assert.equal(await run('previousSends'), 0, 'navigation cannot send or cancel the running task');

    await run('previousKey({ isComposing: true })');
    assert.equal(await run('chatProps.activeConversationId'), 'previous-a');
    await run(`{ const dialog = document.createElement('dialog'); dialog.id = 'previous-modal'; dialog.innerHTML = '<input />'; document.body.append(dialog); dialog.showModal(); }`);
    await run('previousKey({}, "#previous-modal input")');
    assert.equal(await run('chatProps.activeConversationId'), 'previous-a', 'dialog keyboard input stays local');
    await run('document.querySelector("#previous-modal").remove(); previousEnabled = false; updateChat({})');
    await until('previousCommittedEnabled === false', 'disabled shortcut state committed');
    await run('previousKey()');
    assert.equal(await run('chatProps.activeConversationId'), 'previous-a', 'disabled app sections do not switch chats');
    await run('previousEnabled = true; updateChat({}); views.saveKeyboardShortcuts({ previousConversation: null })');
    await run('previousKey()');
    assert.equal(await run('chatProps.activeConversationId'), 'previous-a', 'the shortcut can be disabled');
    await run('views.saveKeyboardShortcuts({ previousConversation: { key: "k", ctrl: true, shift: true } })');
    await pause(40);
    await run('previousKey()');
    assert.equal(await run('chatProps.activeConversationId'), 'previous-a', 'old binding stops after reassignment');
    await run('previousKey({ key: "K", shiftKey: true })'); await selected('previous-b');
    await run('views.saveKeyboardShortcuts({}); selectPreviousFixture("previous-draft")'); await selected('previous-draft');
    await run('previousKey()'); await selected('previous-b');
    await run('previousKey()'); await selected('previous-draft');
    assert.equal(await run('document.querySelector("[data-composer-input]").value'), '尚未发送的新会话', 'prepared conversations and their drafts can be revisited');
    for (const id of ['previous-c', 'previous-a', 'previous-b']) { await run(`selectPreviousFixture('${id}')`); await selected(id); }
    await run('previousTargets = previousTargets.filter(item => item.id !== "previous-a"); updateChat({})');
    // Updating fixture props schedules a React commit. A synthetic key must not
    // run against the previous render's still-valid list of conversations.
    await until('previousCommittedTargets === previousTargets', 'deleted conversation list committed');
    await run('previousKey()'); await selected('previous-c');
    console.log('Previous conversation passed: MRU toggle, background order, repeats/IME, saved drafts/reading position, live task isolation, slash menu, dialogs, disable/rebind, prepared and deleted conversations.');
  } finally {
    await run('document.querySelector("#previous-modal")?.remove(); updateChat = previousSaved.updateChat; views.saveKeyboardShortcuts(JSON.parse(previousSaved.settings || "{}")); updateChat(previousSaved.props)');
  }
};
