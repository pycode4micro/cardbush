const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const styleKey = await window.webContents.insertCSS('.app { width: 100% !important; }');
  const originalBounds = window.getBounds();
  // The prior fixture can still have a textarea while its replacement is
  // pending. Mount this fixture before sending input to its event handlers.
  await run('renderView(null)');
  await until('!document.querySelector(".chat-panel")', 'prior composer fixture unmounted');
  await run(`
    window.inputSavedProps = { ...chatProps }; window.inputSavedTheme = window.viewTheme;
    window.inputSent = [];
    window.inputSkill = { name: 'seedance-ecommerce-video', displayName: 'Seedance 电商视频', description: '根据素材制作视频',
      path: 'C:/Users/EDY/AppData/Roaming/cardbush/skills/seedance-ecommerce-video/SKILL.md' };
    window.inputSkillLink = '[seedance-ecommerce-video](<' + inputSkill.path + '>)';
    window.inputKey = (key, repeat = false, options = {}) => {
      const node = document.querySelector('[data-composer-input]'); node.focus();
      const event = new KeyboardEvent('keydown', { key, repeat, bubbles: true, cancelable: true, ...options });
      node.dispatchEvent(event); return event.defaultPrevented;
    };
    window.inputType = text => {
      const node = document.querySelector('textarea[data-composer-input]'); node.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, text);
      node.setSelectionRange(text.length, text.length); node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.inputSelectAll = () => {
      const node = document.querySelector('.composer-prompt-editor'); node.focus();
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    };
    updateChat({ language: 'zh', sending: false, stopping: false, activeTurnId: '', goalAvailable: true, draft: '',
      skills: [inputSkill, ...Array.from({ length: 16 }, (_, i) => ({ name: 'fixture-skill-' + i, description: 'Skill ' + i, path: 'D:/skills/fixture-' + i + '/SKILL.md' }))],
      availableModels: [{ id: 'fixture', modelName: 'fixture', provider: 'fixture', enabled: true }], selectedModel: 'fixture',
      onDraftChange: draft => updateChat({ draft }), onSend: async text => { inputSent.push(text); updateChat({ draft: '' }); } });
  `);
  try {
    await until('!!document.querySelector("textarea[data-composer-input]")', 'plain composer ready');
    await run('document.querySelector(".message-list").focus()');
    const paddingPoint = await run(`(() => {
      const surface = document.querySelector('.composer-surface'), rect = surface.getBoundingClientRect();
      const x = Math.ceil(rect.left + 6), y = Math.ceil(rect.top + 6);
      if (document.elementFromPoint(x, y) !== surface) throw Error('Fixture must click composer padding');
      return { x, y };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...paddingPoint, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...paddingPoint, button: 'left', clickCount: 1 });
    await until('document.activeElement === document.querySelector("textarea[data-composer-input]")', 'padding click keeps the editor focused after the default mouse action');
    await window.webContents.insertText('留白点击后可以输入');
    await until('chatProps.draft === "留白点击后可以输入"', 'typing after a real padding click');
    await run('inputType("/")');
    await until('document.querySelectorAll(".composer-command-row").length > 15', 'scrollable quick actions');
    const choices = await run('[...document.querySelectorAll(".composer-command-row")].map(row => row.dataset.commandId)');
    const originalTop = await run('document.querySelector(".message-list").scrollTop');
    for (let i = 1; i <= 10; i++) {
      assert.equal(await run(`inputKey('ArrowDown', ${i > 1})`), true, 'held arrows are consumed by the menu');
      await until(`document.querySelector('.composer-command-row.active')?.dataset.commandId === ${JSON.stringify(choices[i])}`, 'held Down advances selection');
    }
    assert.ok(await run('document.querySelector(".composer-command-list").scrollTop > 0'), 'the menu follows a held key');
    const inView = () => run(`(() => { const row = document.querySelector('.composer-command-row.active').getBoundingClientRect();
      const list = document.querySelector('.composer-command-list').getBoundingClientRect(); return row.top >= list.top - 1 && row.bottom <= list.bottom + 1; })()`);
    assert.equal(await inView(), true, 'selected row stays visible');
    assert.equal(await run('document.querySelector(".message-list").scrollTop'), originalTop, 'menu navigation does not scroll the conversation');
    for (let i = 9; i >= 0; i--) {
      await run('inputKey("ArrowUp", true)');
      await until(`document.querySelector('.composer-command-row.active')?.dataset.commandId === ${JSON.stringify(choices[i])}`, 'held Up advances selection');
    }
    await run('inputKey("ArrowUp", true)');
    await until(`document.querySelector('.composer-command-row.active')?.dataset.commandId === ${JSON.stringify(choices.at(-1))}`, 'Up wraps to the last option');
    assert.equal(await inView(), true);
    assert.equal(await run('inputKey("Enter", true)'), true);
    assert.equal(await run('inputKey("Tab", true)'), true);
    assert.equal(await run('chatProps.draft'), '/', 'held confirmation keys do not invoke or send repeatedly');
    assert.deepEqual(await run('inputSent'), []);

    await run('inputType("/seedance")');
    await until('document.querySelectorAll(".composer-command-row").length === 1', 'skill search');
    await run('inputKey("Tab")');
    await until('!!document.querySelector(".composer-skill-token")', 'skill renders as an inline token');
    await until('document.activeElement === document.querySelector(".composer-prompt-editor")', 'caret follows insertion');
    assert.equal(await run('document.querySelector(".composer-skill-token").dataset.skillReference'), await run('inputSkillLink'));
    assert.equal(await run('document.querySelector(".composer-skill-token").title'), await run('inputSkill.path'));
    assert.equal(await run('document.querySelector(".composer-skill-token > span").textContent'), 'Seedance 电商视频');
    assert.doesNotMatch(await run('document.querySelector(".composer-prompt-editor").textContent'), /C:\/Users|SKILL\.md/);
    await run('window.inputSkills = chatProps.skills; updateChat({ skills: [] })');
    await until('document.querySelector(".composer-skill-token > span")?.textContent === "seedance-ecommerce-video"', 'saved references remain tokens before catalog loading');
    await run('updateChat({ skills: inputSkills })');
    await until('document.querySelector(".composer-skill-token > span")?.textContent === "Seedance 电商视频"', 'catalog refresh restores the display name');
    await window.webContents.insertText(' 使用这项技能');
    await until('chatProps.draft.endsWith(" 使用这项技能")', 'typing after the token');
    await run(`inputSelectAll(); const data = new DataTransfer(); document.activeElement.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })); window.inputCopied = data.getData('text/plain');`);
    assert.equal(await run('inputCopied'), await run('chatProps.draft'), 'copy preserves the full skill reference and text');
    await run('getSelection().collapseToEnd(); inputKey("Enter", false, { isComposing: true })');
    assert.deepEqual(await run('inputSent'), [], 'IME confirmation never sends a skill draft');

    for (const theme of ['theme-dark', 'theme-bright']) {
      await run(`window.viewTheme = ${JSON.stringify(theme)}; updateChat({});`);
      window.setContentSize(430, 760);
      await pause(100);
      assert.ok(await run('document.querySelector(".composer-skill-token").getBoundingClientRect().width <= document.querySelector(".composer-prompt-editor").clientWidth'), 'skill tokens fit narrow inputs');
      await fs.writeFile(path.join(root, 'tmp/composer-skill-' + theme + '.png'), (await window.capturePage()).toPNG());
    }
    window.setBounds(originalBounds);
    await run('inputKey("Enter", true)');
    assert.deepEqual(await run('inputSent'), [], 'holding Send does not submit');
    await run('inputKey("Enter")');
    await until('inputSent.length === 1', 'skill draft sent');
    assert.equal(await run('inputSent[0]'), await run('inputCopied'), 'the model receives the exact skill path, not only its label');
    await until('!!document.querySelector("textarea[data-composer-input]")', 'empty composer after sending');
    await run('inputType("前文 " + inputSkillLink + " 后文")');
    await until('!!document.querySelector(".composer-skill-token button")', 'pasted reference is recognized');
    await run('document.querySelector(".composer-skill-token button").click()');
    await until('!!document.querySelector("textarea[data-composer-input]")', 'last token removed');
    assert.equal(await run('chatProps.draft'), '前文  后文', 'removal preserves surrounding text');
    await run('inputType(inputSkillLink + " ")');
    await until('!!document.querySelector(".composer-skill-token")', 'skill ready for Backspace');
    await run('inputSelectAll(); getSelection().collapseToEnd()');
    for (let i = 0; i < 2; i++) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      await pause(50);
    }
    await until('!!document.querySelector("textarea[data-composer-input]")', 'Backspace removes the atomic reference');
    assert.equal(await run('chatProps.draft.trim()'), '', 'no hidden path fragments remain');
    await run(`inputType(inputSkillLink + ' ');`);
    await until('!!document.querySelector(".composer-skill-token")', 'rich input ready for interrupted composition');
    await run(`(() => {
      const editor = document.querySelector('.composer-prompt-editor');
      editor.focus(); editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }));
      document.querySelector('.message-list').focus();
      inputSelectAll(); getSelection().collapseToEnd();
    })()`);
    await window.webContents.insertText('恢复输入');
    await until('chatProps.draft.endsWith("恢复输入")', 'an interrupted IME composition cannot permanently block rich input');
    window.webContents.debugger.attach('1.3');
    try {
      for (const rich of [true, false]) {
        await run(`updateChat({ draft: ${rich ? 'inputSkillLink + " "' : '"普通输入 "'} })`);
        await until(`!!document.querySelector('${rich ? '.composer-prompt-editor' : 'textarea[data-composer-input]'}')`, 'IME editor ready');
        await run(rich ? 'inputSelectAll(); getSelection().collapseToEnd()' : 'inputType(chatProps.draft)');
        const before = await run('chatProps.draft');
        const sentCount = await run('inputSent.length');
        await run('window.composingNode = document.querySelector("[data-composer-input]"); void 0');
        await window.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
        await until('document.querySelector("[data-composer-input]").textContent.endsWith("ni") || document.querySelector("[data-composer-input]").value?.endsWith("ni")', 'native IME preedit reaches the editor');
        if (rich) assert.equal(await run('chatProps.draft'), before, 'unconfirmed rich-editor composition is not published');
        await run('updateChat({})');
        await pause(40);
        assert.equal(await run('document.querySelector("[data-composer-input]") === composingNode'), true, 'rerender preserves the composing node');
        await window.webContents.debugger.sendCommand('Input.insertText', { text: '你好' });
        await until(`chatProps.draft === ${JSON.stringify(before + '你好')}`, 'native IME commit replaces the preedit without losing the draft');
        assert.equal(await run('inputSent.length'), sentCount, 'confirming Chinese text never submits the message');
      }
    } finally { window.webContents.debugger.detach(); }
    console.log('Composer input passed: padding focus, held arrows, native Chinese composition across rerenders, interrupted IME recovery, skill chips, exact copy/send, remove/Backspace and narrow layouts.');
  } finally {
    window.setBounds(originalBounds);
    await run('window.viewTheme = inputSavedTheme; updateChat(inputSavedProps)');
    await window.webContents.removeInsertedCSS(styleKey);
  }
};
