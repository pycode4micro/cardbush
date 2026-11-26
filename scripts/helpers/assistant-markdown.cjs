const assert = require('node:assert/strict');

module.exports = async ({ read, until, win }) => {
  const code = `$value = '${'abcdefghij'.repeat(120)}'\n\n    Write-Output $value\n`;
  const content = ['Fixture', '', '```powershell', code.slice(0, -1), '```',
    '', '```', code.slice(0, -1), '```'].join('\n');
  const reply = '[data-message-id="markdown-overflow"]';
  await read(`
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { fixture.copiedMarkdownCode = text; },
    } });
    fixture.entries.push({ id: 'markdown-overflow', role: 'assistant', content: ${JSON.stringify(content)},
      source: 'page', visibility: 'conversation', createdAt: new Date().toISOString() });
  `);
  const blocks = `${reply} .markdown-code-block`;
  await until(`document.querySelectorAll(${JSON.stringify(blocks)}).length === 2
    && !!document.querySelector(${JSON.stringify(reply + ' .syntax-highlighted .token')})`);

  const bounds = win.getBounds();
  for (const [width, theme, language] of [[800, 'dark', 'zh'], [430, 'bright', 'en']]) {
    win.setSize(width, bounds.height);
    await read(`fixture.theme('${theme}'); fixture.language('${language}')`);
    await until(`innerWidth === ${width} && !!document.querySelector('.app.theme-${theme}')`);
    for (let index = 0; index < 2; index++) {
      const onBlock = expression => read(`(() => {
        const block = document.querySelectorAll(${JSON.stringify(blocks)})[${index}];
        const pre = block.querySelector('pre');
        const wrap = block.querySelector('button[aria-pressed]');
        const copy = block.querySelector('button:last-child');
        ${expression}
      })()`);
      assert.deepEqual(await onBlock(`
        const outer = block.getBoundingClientRect();
        const bubble = block.closest('.assistant-text-bubble').getBoundingClientRect();
        const scroll = block.closest('.assistant-messages').getBoundingClientRect();
        return {
          fits: outer.left >= bubble.left && outer.right <= bubble.right && outer.right <= scroll.right,
          wrapVisible: wrap.getBoundingClientRect().right <= outer.right,
          copyVisible: copy.getBoundingClientRect().right <= outer.right,
          scrolls: pre.scrollWidth > pre.clientWidth,
        };
      `), { fits: true, wrapVisible: true, copyVisible: true, scrolls: true });
      assert.equal(await onBlock(`
        pre.scrollLeft = pre.scrollWidth;
        return pre.scrollLeft > 0;
      `), true, 'long lines scroll inside the code area');
      const unwrappedHeight = await onBlock('wrap.click(); return pre.clientHeight;');
      await until(`document.querySelectorAll(${JSON.stringify(blocks)})[${index}]
        .querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true'`);
      assert.deepEqual(await onBlock(`
        return {
          wraps: pre.clientHeight > ${unwrappedHeight} && pre.scrollWidth <= pre.clientWidth + 1,
          preservesWhitespace: getComputedStyle(pre.querySelector('code')).whiteSpace === 'pre-wrap',
          text: pre.textContent,
        };
      `), { wraps: true, preservesWhitespace: true, text: code });
      await onBlock("fixture.copiedMarkdownCode = ''; copy.click();");
      await until(`fixture.copiedMarkdownCode === ${JSON.stringify(code)}`);
      await onBlock('wrap.click();');
    }
  }

  // The offscreen window has no OS keyboard focus. Force Chromium's focus
  // pseudo-classes to check the viewport and message styles independently.
  const debuggerClient = win.webContents.debugger;
  debuggerClient.attach();
  try {
    await debuggerClient.sendCommand('DOM.enable');
    await debuggerClient.sendCommand('CSS.enable');
    const { root } = await debuggerClient.sendCommand('DOM.getDocument');
    for (const [selector, outline] of [['.assistant-messages', 'none'], [reply + ' article', 'solid']]) {
      const { nodeId } = await debuggerClient.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      await debuggerClient.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
      assert.equal(await read(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).outlineStyle`), outline);
    }
  } finally {
    debuggerClient.detach();
  }
  win.setBounds(bounds);
  console.log('Assistant Markdown passed: visible controls, local scroll, exact copy, wrapping and transcript focus.');
};
