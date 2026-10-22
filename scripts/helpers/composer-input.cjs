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
    window.inputSavedCommands = cardbushDesktop.pluginCommands;
    window.inputSavedCatalogChanged = cardbushDesktop.onCapabilityCatalogChanged;
    window.inputSent = [];
    window.inputSkill = { name: 'seedance-ecommerce-video', displayName: 'Seedance 电商视频', description: '根据素材制作视频',
      path: 'C:/Users/Fixture/AppData/Roaming/cardbush/skills/seedance-ecommerce-video/SKILL.md' };
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
    // Plugin Skills use the command catalog, not Markdown links. Exercise the
    // real picker and editor together so rendering cannot change invocation policy.
    await run('renderView(null)');
    await until('!document.querySelector(".chat-panel")', 'remount with plugin command services');
    await run(`
      window.inputPluginCommand = { id: 'baiying-replay:baiying-replay', pluginId: 'baiying-replay',
        name: 'baiying-replay', kind: 'skill', description: '百应回放素材', argumentHint: '[商品]',
        path: 'C:/plugins/baiying-replay/skills/baiying-replay/SKILL.md' };
      window.inputCommandCatalog = [inputPluginCommand, { id: 'demo:review', name: 'review', kind: 'command', description: 'Review', argumentHint: '' }];
      window.inputCatalogListeners = new Set();
      window.inputCatalogReads = 0; window.inputCatalogFails = false;
      cardbushDesktop.pluginCommands = async () => {
        inputCatalogReads++;
        if (inputCatalogFails) throw Error('offline fixture refresh failure');
        return inputCommandCatalog;
      };
      cardbushDesktop.onCapabilityCatalogChanged = callback => { inputCatalogListeners.add(callback); return () => inputCatalogListeners.delete(callback); };
      window.inputRefreshCommands = () => { for (const callback of inputCatalogListeners) callback(); };
      window.inputPluginSkill = { name: inputPluginCommand.id, displayName: '百应回放', description: '素材获取', path: inputPluginCommand.path };
      inputSent = [];
      updateChat({ draft: '', skills: [...inputSkills, inputPluginSkill] });
    `);
    await until('!!document.querySelector("textarea[data-composer-input]") && inputCatalogReads > 0', 'plugin commands ready');
    for (const selection of ['Tab', 'Enter', 'click']) {
      await run('inputType("/baiying")');
      await until('document.querySelectorAll(".composer-command-row").length === 1', 'plugin Skill search result');
      if (selection === 'click') {
        const point = await run(`(() => { const rect = document.querySelector('.composer-command-row').getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
        window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      } else await run(`inputKey(${JSON.stringify(selection)})`);
      await until('!!document.querySelector(".composer-skill-token") && !document.querySelector(".composer-command-palette")', selection + ' selects a Skill token');
      assert.equal(await run('document.querySelector(".composer-skill-token > span").textContent'), '百应回放');
      assert.equal(await run('document.querySelector(".composer-skill-token").dataset.skillReference'), '/baiying-replay:baiying-replay');
      assert.equal(await run('document.querySelector(".composer-skill-token").title'), '/baiying-replay:baiying-replay\nC:/plugins/baiying-replay/skills/baiying-replay/SKILL.md');
      assert.equal(await run('chatProps.draft'), '/baiying-replay:baiying-replay ');
      await until('document.activeElement === document.querySelector(".composer-prompt-editor")', 'selection retains typing focus');
      await window.webContents.insertText('"KST 1606" 使用原声');
      await until('chatProps.draft.endsWith("使用原声")', selection + ': arguments can be typed after the Skill');
      await run(`(() => { inputSelectAll(); const clipboard = new DataTransfer();
        document.activeElement.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard }));
        window.inputPluginCopied = clipboard.getData('text/plain'); getSelection().collapseToEnd(); })()`);
      assert.equal(await run('inputPluginCopied'), '/baiying-replay:baiying-replay "KST 1606" 使用原声');
      const sentBefore = await run('inputSent.length');
      await run('inputKey("Enter")');
      await until(`inputSent.length === ${sentBefore + 1}`, 'submit the original Skill invocation');
      assert.equal(await run('inputSent.at(-1)'), await run('inputPluginCopied'));
      await until('!!document.querySelector("textarea[data-composer-input]") && !chatProps.draft', 'Skill clears after send');
    }
    await run('inputType("/baiying-replay:baiying-replay 保留这些参数")');
    await until('!!document.querySelector(".composer-skill-token")', 'saved slash draft renders without selecting again');
    await run('window.inputPluginEditor = document.querySelector(".composer-prompt-editor"); inputSelectAll(); getSelection().collapseToEnd(); inputCatalogFails = true; inputRefreshCommands();');
    await pause(80);
    assert.equal(await run('document.querySelector(".composer-prompt-editor") === inputPluginEditor'), true, 'failed refresh does not replace the editor');
    await run('inputCatalogFails = false; updateChat({ skills: [] }); inputRefreshCommands();');
    await until('document.querySelector(".composer-skill-token > span")?.textContent === "baiying-replay"', 'command catalog renders without the separate Skill catalog');
    await run('updateChat({ skills: [inputPluginSkill] })');
    await until('document.querySelector(".composer-skill-token > span")?.textContent === "百应回放"', 'late Skill metadata enriches the token');
    await window.webContents.insertText('继续');
    await until('chatProps.draft === "/baiying-replay:baiying-replay 保留这些参数继续"', 'refresh preserves the caret and draft');
    await fs.writeFile(path.join(root, 'tmp/composer-plugin-skill.png'), (await window.capturePage()).toPNG());
    await run('document.querySelector(".composer-skill-token button").click()');
    await until('!!document.querySelector("textarea[data-composer-input]")', 'remove command token');
    assert.equal(await run('chatProps.draft'), ' 保留这些参数继续', 'remove leaves only the user arguments');
    await run('inputType("/baiying-replay:baiying-replay"); inputKey("Escape")');
    await until('!!document.querySelector(".composer-skill-token")', 'command token ready for Backspace');
    await run('inputSelectAll(); getSelection().collapseToEnd()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await until('chatProps.draft === "" && !!document.querySelector("textarea[data-composer-input]")', 'Backspace removes the whole Skill command');
    await run('inputType("/demo:review 文件"); inputKey("Escape")');
    assert.equal(await run('document.querySelector(".composer-skill-token")'), null, 'ordinary commands keep plain text editing');
    await run('inputType("/baiying-replay:baiying-replay 参数"); inputKey("Escape")');
    await until('!!document.querySelector(".composer-skill-token")', 'Skill draft before catalog removal');
    await run('inputCommandCatalog = []; inputRefreshCommands()');
    await until('!!document.querySelector("textarea[data-composer-input]")', 'uninstalled Skill falls back to editable text');
    assert.equal(await run('chatProps.draft'), '/baiying-replay:baiying-replay 参数', 'catalog removal never changes the prompt');
    await run(`renderView(h(views.ComposerPromptInput, {
      value: '/baiying-replay:baiying-replay 云端参数', plugins: [], pluginCommands: [inputPluginCommand],
      skills: [{ ...inputPluginSkill, logoPath: 'C:/remote-host/skill-logo.png' }], richReferences: 'applications',
      language: 'zh', placeholder: '', onChange: () => {}, onSelectionChange: () => {}, onKeyDown: () => {}
    }))`);
    await until('!!document.querySelector(".composer-skill-token")', 'remote Skill command uses the same token');
    assert.equal(await run('document.querySelector(".composer-skill-token > span").textContent'), '百应回放');
    assert.equal(await run('document.querySelector(".composer-skill-token img")'), null, 'remote filesystem logos must not resolve on the local host');

    // Sending previously lost the token because the transcript had no command
    // resolver. Exercise actual message Markdown and its owning host as well.
    await run(`
      window.inputBubbleContent = '/baiying-replay:baiying-replay 这里的**依赖**配置好了吗，参考 https://example.com/docs，继续检查。';
      window.inputBubbleMessage = { id: 'skill-message', role: 'user', content: inputBubbleContent };
      window.inputBubbleProps = { message: inputBubbleMessage, language: 'zh', sending: false,
        activeTurnId: '', activeAssistantMessageId: '', onRegenerate: async () => {},
        onEditUserMessage: async () => {}, onRetryGuidance: async () => {}, onRevertChangeReport: async () => {}, onOpenScene: () => {} };
      window.inputSkillOpened = []; window.inputLocalSkillOpened = [];
      window.inputObserveSkillOpen = event => inputLocalSkillOpened.push(event.detail.target);
      addEventListener('cardbush:open-inspector', inputObserveSkillOpen);
      inputCommandCatalog = [inputPluginCommand];
      window.inputHistoryReads = inputCatalogReads;
      renderView(h('div', null, Array.from({ length: 12 }, (_, i) =>
        h(views.MessageBubble, { ...inputBubbleProps, key: i, message: { ...inputBubbleMessage, id: 'skill-' + i } }))));
    `);
    await until('document.querySelectorAll(".markdown-content .skill-reference-token").length === 12', 'saved messages render their Skill invocations');
    assert.equal(await run('inputCatalogReads - inputHistoryReads'), 1, 'history messages share a single catalog request');
    assert.equal(await run('document.querySelector(".user-message-body strong").textContent'), '依赖', 'argument Markdown remains intact');
    assert.equal(await run(`document.querySelector('.user-message-body a[href^="https://"]').getAttribute('href')`), 'https://example.com/docs', 'Chinese URL boundaries and Skill tokens coexist');
    await run('document.querySelector(".skill-reference-token").click()');
    assert.deepEqual(await run('inputLocalSkillOpened'), [await run('inputPluginCommand.path')]);
    await run(`
      window.inputSkillHost = { id: 'remote-skill-fixture', plugins: [], pluginCommands: [],
        openFile: path => inputSkillOpened.push(path), messageFeedbackAvailable: false };
      window.inputRenderSkillMessage = () => renderView(h(views.ConversationHostContext.Provider, { value: inputSkillHost },
        h(views.MessageBubble, { ...inputBubbleProps, key: inputBubbleMessage.id, message: inputBubbleMessage })));
      inputHistoryReads = inputCatalogReads;
      inputRenderSkillMessage();
    `);
    await until('document.querySelectorAll(".user-message-body").length === 1 && !document.querySelector(".skill-reference-token")', 'remote catalog never falls back to a cached local Skill');
    await run(`inputSkillHost = { ...inputSkillHost, pluginCommands: [{ ...inputPluginCommand, path: 'C:/remote-agent/plugins/baiying/SKILL.md' }] }; inputRenderSkillMessage();`);
    await until('!!document.querySelector(".markdown-content .skill-reference-token")', 'late remote catalog renders historical commands');
    assert.equal(await run('inputCatalogReads'), await run('inputHistoryReads'), 'remote messages do not query local commands');
    assert.equal(await run('document.querySelector(".skill-reference-token").dataset.skillReference'), '/baiying-replay:baiying-replay');
    await run('document.querySelector(".skill-reference-token").click()');
    assert.deepEqual(await run('inputSkillOpened'), ['C:/remote-agent/plugins/baiying/SKILL.md']);
    assert.equal(await run('inputLocalSkillOpened.length'), 1, 'remote Skill click cannot open the local copy');
    await run(`window.inputSavedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.inputBubbleCopied = text; } } });
      document.querySelector('.message-actions button[title="复制"]').click();`);
    await until('inputBubbleCopied === inputBubbleContent', 'copy preserves the original command and all parameters');
    await fs.writeFile(path.join(root, 'tmp/skill-message-reference.png'), (await window.capturePage()).toPNG());
    await run(`document.querySelector('.message-actions button[title="编辑并重跑"]').click()`);
    await until('!!document.querySelector(".user-edit-card textarea")', 'editing the saved message');
    assert.equal(await run('document.querySelector(".user-edit-card textarea").value'), await run('inputBubbleContent'));
    for (const id of ['demo:_review_', '__demo__:review', 'demo:_review']) {
      const content = '/' + id + ' 参数_ 与**加粗** https://example.com/docs，检查链接。';
      await run(`inputSkillHost = { ...inputSkillHost, pluginCommands: [{ ...inputPluginCommand, id: ${JSON.stringify(id)}, name: ${JSON.stringify(id.split(':')[1])} }] };
        inputBubbleMessage = { id: ${JSON.stringify(id)}, role: 'user', content: ${JSON.stringify(content)} }; inputRenderSkillMessage();`);
      await until(`document.querySelector('.markdown-content .skill-reference-token')?.dataset.skillReference === ${JSON.stringify('/' + id)}`, 'Markdown punctuation in command IDs');
      assert.equal(await run('document.querySelector(".user-message-body strong").textContent'), '加粗');
      assert.equal(await run(`document.querySelector('.user-message-body a[href^="https://"]').getAttribute('href')`), 'https://example.com/docs');
      await run(`document.querySelector('.message-actions button[title="复制"]').click()`);
      await until(`inputBubbleCopied === ${JSON.stringify(content)}`, 'rendering escapes never enter copied messages');
    }
    await run('inputSkillHost = { ...inputSkillHost, pluginCommands: [inputPluginCommand] }; void 0;');
    for (const [role, content] of [['assistant', '/baiying-replay:baiying-replay 说明'], ['user', '`/baiying-replay:baiying-replay` 说明'], ['user', '/demo:review 文件']]) {
      await run(`inputBubbleMessage = { id: ${JSON.stringify(role + content)}, role: ${JSON.stringify(role)}, content: ${JSON.stringify(content)} }; inputRenderSkillMessage();`);
      await until('!!document.querySelector(".markdown-content") && !document.querySelector(".markdown-fallback")', 'literal message loaded');
      assert.equal(await run('document.querySelector(".skill-reference-token")'), null, 'only user Skill invocations become tokens');
    }
    console.log('Composer and Skill messages passed: selection/send/copy/edit, Markdown, shared catalog, refresh/removal, local/remote file routing, literal examples and IME.');
  } catch (error) {
    console.error('Composer fixture state:', await run(`JSON.stringify({ draft: chatProps.draft, sent: inputSent,
      input: document.querySelector('[data-composer-input]')?.outerHTML,
      focus: document.activeElement?.className, anchor: getSelection()?.anchorNode?.textContent, offset: getSelection()?.anchorOffset })`));
    throw error;
  } finally {
    window.setBounds(originalBounds);
    await run(`renderView(null); cardbushDesktop.pluginCommands = inputSavedCommands;
      cardbushDesktop.onCapabilityCatalogChanged = inputSavedCatalogChanged; window.viewTheme = inputSavedTheme;
      if (window.inputObserveSkillOpen) removeEventListener('cardbush:open-inspector', inputObserveSkillOpen);
      if (window.inputSavedClipboard) Object.defineProperty(navigator, 'clipboard', inputSavedClipboard);
      else if (window.inputBubbleCopied !== undefined) delete navigator.clipboard;`);
    await until('!document.querySelector(".chat-panel")', 'input fixture unmounted');
    await run('updateChat(inputSavedProps)');
    await window.webContents.removeInsertedCSS(styleKey);
  }
};
