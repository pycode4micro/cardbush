const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/settings/keyboardSettings.css'), 'utf8'));
  await run(`window.keyboardSavedChat = { ...chatProps }; window.keyboardEvents = [];
    window.shortcutKey = (selector, key, options = {}) => {
      const element = document.querySelector(selector); element.focus();
      return element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
    };
    window.showKeyboardSettings = language => renderView(h('section', { style: { width: '100%', height: '100%', overflow: 'auto', padding: 32 } },
      h('header', { className: 'settings-page-header' }, h('h1', null, language === 'zh' ? '快捷键' : 'Keyboard shortcuts')),
      h(views.SettingsKeyboardPanel, { language })));
    window.keyboardRecorder = id => '[data-shortcut-recorder="' + id + '"]';
    views.saveKeyboardShortcuts({}); showKeyboardSettings('zh'); void 0;`);
  await until("!!document.querySelector('[data-keyboard-settings]')", 'keyboard settings');
  try {
    assert.equal(await run("document.querySelectorAll('[data-shortcut-row]').length"), 11);
    await run(`document.querySelector(keyboardRecorder('guideNow')).click()`);
    await pause(30);
    await run(`shortcutKey(keyboardRecorder('guideNow'), 't', { ctrlKey: true })`);
    await until("document.querySelector('[role=alert]')?.textContent.includes('冲突')", 'binding conflict');
    assert.equal(await run("localStorage.getItem(views.keyboardShortcutsStorageKey)"), '{}');
    await run(`shortcutKey(keyboardRecorder('guideNow'), 'x')`);
    await until("document.querySelector('[role=alert]')?.textContent.includes('Ctrl')", 'typing key rejected');
    await run(`shortcutKey(keyboardRecorder('guideNow'), 'U', { ctrlKey: true, shiftKey: true })`);
    await until("document.querySelector('[data-shortcut-recorder=guideNow]').textContent.includes('Ctrl + Shift + U')", 'new binding saved');
    assert.equal(await run("JSON.parse(localStorage.getItem(views.keyboardShortcutsStorageKey)).guideNow.key"), 'u');
    await run(`showKeyboardSettings('en')`);
    await until("document.querySelector('[data-shortcut-row=guideNow]').textContent.includes('Send guidance now')", 'English settings');
    assert.ok(await run("document.querySelector('[data-shortcut-recorder=guideNow]').textContent.includes('Ctrl + Shift + U')"));
    await run("showKeyboardSettings('zh')");
    await pause(100);
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp/keyboard-settings-preview.png'), (await window.capturePage()).toPNG());

    await run(`updateChat({ ...keyboardSavedChat, language: 'zh', sending: true, activeTurnId: 'turn-a', draft: '直接引导草稿',
      guidanceDeliveryMode: 'queue', queuedMessages: [], queuedMessageCount: 0,
      onDraftChange: draft => updateChat({ draft }),
      onSend: async text => { keyboardEvents.push({ kind: 'send', text }); },
      onCancel: async () => { keyboardEvents.push({ kind: 'cancel' }); },
      onGuideMessage: async (anchor, text, mode) => {
        keyboardEvents.push({ kind: 'guide', text, turnId: anchor.turnId, mode });
        await new Promise(resolve => { window.finishKeyboardGuide = resolve; });
      },
      onGuideQueuedMessage: async (id, mode) => {
        keyboardEvents.push({ kind: 'queue', id, mode });
        const queuedMessages = chatProps.queuedMessages.filter(item => item.id !== id);
        updateChat({ queuedMessages, queuedMessageCount: queuedMessages.length });
      }
    });`);
    await until("!!document.querySelector('[data-composer-input]')", 'guidance composer');
    await run(`shortcutKey('[data-composer-input]', 'Enter', { ctrlKey: true })`);
    assert.deepEqual(await run('keyboardEvents'), [], 'old shortcut must stop working after reassignment');
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true, isComposing: true })`);
    assert.deepEqual(await run('keyboardEvents'), [], 'IME confirmation must not send guidance');
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true })`);
    await until("keyboardEvents.length === 1 && chatProps.draft === ''", 'draft becomes guidance');
    assert.deepEqual(await run('keyboardEvents[0]'), { kind: 'guide', text: '直接引导草稿', turnId: 'turn-a', mode: 'append_context' });
    await run(`updateChat({ queuedMessages: [{ id: 'q1', text: '队列一' }, { id: 'q2', text: '队列二' }], queuedMessageCount: 2 });`);
    await pause(40);
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true, repeat: true });
      shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true });`);
    assert.equal(await run('keyboardEvents.length'), 1, 'an in-flight gesture must not send a second queued item');
    await run('finishKeyboardGuide()'); await pause(30);

    await run(`updateChat({ queuedMessages: [chatProps.queuedMessages[1], chatProps.queuedMessages[0]] });`); await pause(30);
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true })`);
    await until("keyboardEvents.length === 2", 'first current queue item sent');
    assert.deepEqual(await run('keyboardEvents[1]'), { kind: 'queue', id: 'q2', mode: 'append_context' });
    assert.deepEqual(await run('chatProps.queuedMessages.map(item => item.id)'), ['q1']);

    await run(`updateChat({ draft: '保留的草稿' }); document.querySelector('.composer-queue-button').click();`);
    await until("!!document.querySelector('.runtime-queue-drag-handle')", 'queue view');
    await run(`shortcutKey('.runtime-queue-guide', 'U', { ctrlKey: true, shiftKey: true })`);
    await until("keyboardEvents.length === 3", 'queue focused guidance');
    assert.deepEqual(await run('keyboardEvents[2]'), { kind: 'queue', id: 'q1', mode: 'append_context' });
    assert.equal(await run('chatProps.draft'), '保留的草稿', 'queue focused shortcut must preserve the composer draft');
    await run(`shortcutKey('[data-composer-input]', 'Enter')`);
    await until('keyboardEvents.length === 4', 'ordinary enter delivery');
    assert.deepEqual(await run('keyboardEvents[3]'), { kind: 'send', text: '保留的草稿' });
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true })`);
    assert.equal(await run('keyboardEvents.length'), 4, 'empty guidance must never stop generation');

    await run(`updateChat({ draft: '尚未可引导', activeTurnId: '' })`); await pause(30);
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true })`);
    assert.equal(await run('chatProps.draft'), '尚未可引导', 'unready turn must retain the draft');
    await run(`updateChat({ draft: '空闲时正常发送', sending: false })`); await pause(30);
    await run(`shortcutKey('[data-composer-input]', 'U', { ctrlKey: true, shiftKey: true })`);
    await until('keyboardEvents.length === 5', 'idle guidance becomes normal send');
    assert.deepEqual(await run('keyboardEvents[4]'), { kind: 'send', text: '空闲时正常发送' });

    await run("showKeyboardSettings('zh')");
    await until("!!document.querySelector('[data-keyboard-settings]')", 'return to keyboard settings');
    await run(`document.querySelector('[aria-label="停用快捷键：立即引导"]').click()`);
    await until("document.querySelector('[data-shortcut-recorder=guideNow]').textContent === '未设置'", 'disable shortcut');
    await run(`document.querySelector('[aria-label="恢复默认：立即引导"]').click()`);
    await until("document.querySelector('[data-shortcut-recorder=guideNow]').textContent === 'Ctrl + Enter'", 'reset shortcut');
    assert.equal(await run('localStorage.getItem(views.keyboardShortcutsStorageKey)'), '{}');
    await run("updateChat({ draft: '默认快捷键引导', sending: true, activeTurnId: 'turn-a' })");
    await until("!!document.querySelector('[data-composer-input]')", 'default binding composer');
    await run("document.querySelector('[data-composer-input]').focus()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await until('keyboardEvents.length === 6', 'native Ctrl Enter sends immediate guidance');
    assert.deepEqual(await run('keyboardEvents[5]'), { kind: 'guide', text: '默认快捷键引导', turnId: 'turn-a', mode: 'append_context' });
    await run('finishKeyboardGuide()'); await pause(30);
    await run("updateChat({ draft: '保留换行' })"); await pause(30);
    await run("document.querySelector('[data-composer-input]').focus()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
    await until("chatProps.draft.includes('\\n')", 'native Shift Enter keeps newline');
    assert.equal(await run('keyboardEvents.length'), 6);
    await run("showKeyboardSettings('zh')");
    await until("!!document.querySelector('[data-keyboard-settings]')", 'settings after default key test');
    await run(`document.querySelector(keyboardRecorder('openFiles')).click()`); await pause(25);
    await run(`shortcutKey(keyboardRecorder('openFiles'), 'o', { ctrlKey: true })`);
    await until("document.querySelector('[data-shortcut-recorder=openFiles]').textContent === 'Ctrl + O'", 'file shortcut remapped');
    await run(`renderView(h(views.InspectorActions, { language: 'zh', filesAvailable: true, shadowUnavailableReason: '',
      onOpenFiles: () => {}, onOpenBrowser: () => {}, onOpenShadow: () => {} }));`);
    await until("document.querySelector('[data-inspector-action=files] kbd')?.textContent === 'Ctrl+O'", 'menu hint follows settings');
    assert.equal(await run("document.querySelector('[data-inspector-action=files]').getAttribute('aria-keyshortcuts')"), 'Control+O');
    await run(`localStorage.setItem(views.keyboardShortcutsStorageKey, JSON.stringify({openFiles:{key:'l',ctrl:true}}));
      dispatchEvent(new StorageEvent('storage', { key: views.keyboardShortcutsStorageKey }));`);
    await until("document.querySelector('[data-inspector-action=files] kbd')?.textContent === 'Ctrl+L'", 'cross-window preference changes');
    console.log('Keyboard UI passed: record/conflict/reset/disable, persistent live bindings, IME/repeat guards, draft and first-queue guidance, retained queue/draft, idle fallback and synchronized menu hints.');
  } finally {
    await run('views.saveKeyboardShortcuts({}); updateChat(keyboardSavedChat)');
  }
};
