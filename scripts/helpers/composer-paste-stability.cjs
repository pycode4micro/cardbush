const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const css = await window.webContents.insertCSS('.app { width:100% !important; }');
  const originalSize = window.getContentSize();
  const results = [];
  await run(String.raw`
    window.pasteStabilitySaved = { props: { ...chatProps }, theme: window.viewTheme, components: localStorage.getItem(views.componentStorageKey) };
    window.startPasteCase = (style, welcome, rich) => {
      const saved = JSON.parse(localStorage.getItem(views.componentStorageKey)) || views.defaultComponents;
      views.saveComponents({ ...saved, welcomeLayout: undefined,
        items: saved.items.map(item => item.id === 'system-input' ? { ...item, inputStyle: style } : item) }, saved.revision);
      window.pasteInitial = rich ? '[fixture](<D:/skills/fixture/SKILL.md>) ' : '';
      updateChat({ activeConversationId: welcome ? '' : 'overflow-paste', language: 'zh',
        loading: false, historyLoading: false, sending: false, stopping: false, activeTurnId: '',
        messages: welcome ? [] : [{ id: 'paste-user', role: 'user', content: '检查粘贴输入' },
          { id: 'paste-answer', role: 'assistant', content: '既有答复保持不动。' }], draft: pasteInitial,
        onDraftChange: draft => updateChat({ draft }) });
    };
    window.preparePasteInput = () => {
      window.pasteInput = document.querySelector('[data-composer-input]');
      pasteInput.focus({ preventScroll: true });
      if (pasteInput instanceof HTMLTextAreaElement) pasteInput.setSelectionRange(pasteInput.value.length, pasteInput.value.length);
      else { const range = document.createRange(); range.selectNodeContents(pasteInput); range.collapse(false);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    };
    window.startPasteFrames = () => {
      window.pasteFrames = []; window.pasteNodes = new Set();
      window.readPasteFrame = () => {
        const input = document.querySelector('[data-composer-input]');
        const surface = document.querySelector('.composer-surface');
        const rect = surface.getBoundingClientRect(); pasteNodes.add(input);
        pasteFrames.push({ top: rect.top, height: rect.height, inputHeight: input.clientHeight,
          inputWidth: input.clientWidth, scroll: input.scrollTop, scrollHeight: input.scrollHeight,
          valueLength: chatProps.draft.length, focus: document.activeElement === input,
          bodyScroll: document.querySelector('.chat-body').scrollTop,
          welcomeScroll: document.querySelector('.welcome-composer')?.scrollTop ?? 0,
          multiline: surface.classList.contains('is-multiline') });
        window.pasteSampleFrame = requestAnimationFrame(readPasteFrame);
      };
      readPasteFrame();
    };
    window.dispatchFixturePaste = text => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      pasteInput.dispatchEvent(event); return event.defaultPrevented;
    };
    void 0;
  `);
  try {
    for (const style of ['standard', 'simple']) for (const welcome of [true, false]) for (const rich of [false, true]) for (const lines of [false, true]) {
      window.setContentSize(lines ? 460 : 1180, 760);
      const label = `${style}-${welcome ? 'welcome' : 'conversation'}-${rich ? 'rich' : 'plain'}-${lines ? 'narrow-lines' : 'wrapped'}`;
      await run(`window.viewTheme=${JSON.stringify(welcome ? 'theme-bright' : 'theme-dark')}; startPasteCase(${JSON.stringify(style)},${welcome},${rich})`);
      await until(`!!document.querySelector('${rich ? '.composer-prompt-editor' : 'textarea[data-composer-input]'}')`, label);
      await pause(300);
      const text = lines ? '逐行粘贴的内容需要稳定显示。\n'.repeat(40)
        : '粘贴后内容超过输入框高度，需要保留光标并且保持稳定。'.repeat(90);
      for (const [step, addition] of [['overflow', text], ['append', '继续粘贴检查内部滚动。'.repeat(12)]]) {
        await run('preparePasteInput()'); await pause(60);
        const expected = await run('chatProps.draft.length') + addition.length;
        await run('startPasteFrames()');
        const handled = await run(`dispatchFixturePaste(${JSON.stringify(addition)})`);
        if (!handled) await window.webContents.insertText(addition);
        await until(`chatProps.draft.length === ${expected}`, label + ' native paste inserted');
        await pause(400);
        const state = await run('cancelAnimationFrame(pasteSampleFrame); ({ frames: pasteFrames, nodes: pasteNodes.size })');
        results.push({ label: label + '-' + step, ...state });
        fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tmp/composer-paste-stability.json'), JSON.stringify(results, null, 2));
        const frames = state.frames.filter(frame => frame.valueLength === expected);
        const range = key => Math.max(...frames.map(frame => frame[key])) - Math.min(...frames.map(frame => frame[key]));
        console.log(label, step, JSON.stringify({ nodes: state.nodes, frames: frames.length,
          topRange: range('top'), heightRange: range('height'), scrollRange: range('scroll') }));
        assert.ok(frames.length > 5, 'sample several paints after insertion');
        assert.equal(state.nodes, 1, 'pasting does not remount the editor');
        assert.ok(frames.every(frame => frame.focus), 'pasting retains focus');
        assert.ok(frames.every(frame => frame.scrollHeight > frame.inputHeight), 'exercise content overflowing the height limit');
        assert.ok(range('top') < 1 && range('height') < 1, label + ': no delayed growth/position correction after paste');
        assert.ok(range('scroll') < 1, label + ': inner scrolling does not bounce after paste');
        assert.ok(frames.every(frame => frame.bodyScroll === 0 && frame.welcomeScroll === 0), 'paste does not scroll the outer page');
      }
    }
    fs.writeFileSync(path.join(root, 'tmp/composer-paste-stability.png'), (await window.webContents.capturePage()).toPNG());
    console.log('Paste stability passed: 32 overflowing/continued pastes, standard/simple, welcome/history, plain/rich, wrapped/multiline and narrow widths.');
  } finally {
    await run(`cancelAnimationFrame(window.pasteSampleFrame); window.viewTheme=pasteStabilitySaved.theme;
      views.saveComponents(pasteStabilitySaved.components ? JSON.parse(pasteStabilitySaved.components) : views.defaultComponents,
        JSON.parse(localStorage.getItem(views.componentStorageKey)).revision);
      updateChat(pasteStabilitySaved.props);`);
    window.setContentSize(...originalSize);
    await window.webContents.removeInsertedCSS(css);
  }
};
