const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, window, root }) => {
  const sizing = await window.webContents.insertCSS('.app { width:100%!important; }');
  const code = 'for (int p = 0; p < _w; p++) {\n    byte* s = src + p*4;\n\n    byte* dd = d + p*3; dd[0]=s[0];\n}\n';
  const content = [
    '关键词：`user_id`、``包含 `反引号` 的关键词``、**`优先处理`**；普通强调：**重要**。', '',
    '字面符号：\\`普通文本\\`；未闭合：`保留原文', '',
    '复现结果：', '```', 'C:/fixture/mjpeg-out.png', '第 4 段实际全黑', '```', '',
    '修法是把两层循环并成按像素的一层：', '', '```csharp', code.trimEnd(), '```', '',
    '复现材料：`harn/MjpegTailHarness.cs`、`src/Sample.fs`、`src/main.cpp`、`config/settings.toml`。',
  ].join('\n');
  await run(`
    window.codeFixtureContent = ${JSON.stringify(content)};
    window.renderCodeFixture = (language = 'zh', role = 'assistant') => renderView(
      h(views.MessageFileReferenceScope, { workspaceRoot: 'C:/fixture' },
        h(views.MessageBubble, { language, sending: false, activeTurnId: '', activeAssistantMessageId: '', message: {
          id: role + '-code-fixture', role, status: 'completed', content: codeFixtureContent,
          metadata: { transcript_kind: 'assistant_final' } } })));
    window.copiedCode = '';
    window.codeCopyFeedback = 0;
    window.onCodeCopyFeedback = () => { codeCopyFeedback++; };
    addEventListener('cardbush-copy-feedback', onCodeCopyFeedback);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copiedCode = text; } } });
    renderCodeFixture();
  `);
  for (const [theme, language] of [['theme-dark', 'zh'], ['theme-bright', 'en']]) {
    await run(`viewTheme = ${JSON.stringify(theme)}; renderCodeFixture(${JSON.stringify(language)})`);
    await until("document.querySelector('code.language-csharp .token.keyword')?.textContent === 'for'", 'C# syntax tokens render');
    await until("document.querySelector('.local-file-type-icon.csharp')?.textContent === 'C#'", 'C# file badge renders');
    assert.deepEqual(await run("Array.from(document.querySelectorAll('.markdown-code-language'), node => node.textContent)"),
      [language === 'zh' ? '纯文本' : 'Plain text', 'C#']);
    assert.equal(await run("document.querySelector('code.language-csharp').textContent"), code, 'highlighter preserves whitespace and blank lines');
    assert.equal(await run("document.querySelectorAll('.message-image-strip').length"), 0, 'code sample path never becomes an image');
    assert.equal(await run("document.querySelector('pre code').textContent"), 'C:/fixture/mjpeg-out.png\n第 4 段实际全黑\n', 'plain code paths stay literal');
    assert.equal(await run("Array.from(document.querySelectorAll('.markdown-content p')).some(node => node.textContent === '修法是把两层循环并成按像素的一层：')"), true);
    assert.equal(await run("document.querySelectorAll('.local-file-type-icon.fsharp, .local-file-type-icon.cpp, .local-file-type-icon.config').length"), 3);
    const copyTitle = language === 'zh' ? '复制' : 'Copy';
    const feedbackBefore = await run('codeCopyFeedback');
    await run(`document.querySelectorAll('.markdown-code-block')[1].querySelector('button[title="${copyTitle}"]').click()`);
    await until(`copiedCode === ${JSON.stringify(code)}`, 'copy contains exact source without labels');
    await until(`codeCopyFeedback === ${feedbackBefore + 1}`, 'code copy signals success');
    await run(`document.querySelector('.message-actions button[title="${copyTitle}"]').click()`);
    await until('copiedCode === codeFixtureContent', 'assistant copy preserves complete Markdown, not rendered labels');
    await until(`codeCopyFeedback === ${feedbackBefore + 2}`, 'message copy signals success');
    await run("document.querySelectorAll('.markdown-code-block')[1].querySelector('button[aria-pressed]').click()");
    assert.equal(await run("document.querySelectorAll('.markdown-code-block')[1].querySelector('button[aria-pressed]').getAttribute('aria-pressed')"), theme === 'theme-dark' ? 'true' : 'false');
    assert.notEqual(await run("getComputedStyle(document.querySelector('code.language-csharp .token.keyword')).color"),
      await run("getComputedStyle(document.querySelector('code.language-csharp .token.punctuation')).color"), 'syntax colors follow each theme');
    if (theme === 'theme-dark') {
      const screenshotPath = path.join(root, 'tmp', 'code-rendering-dark.png');
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());
    }
  }
  for (const [theme, language] of [['theme-dark', 'zh'], ['theme-bright', 'en']]) {
    const copyTitle = language === 'zh' ? '复制' : 'Copy';
    const feedbackBefore = await run('codeCopyFeedback');
    await run(`copiedCode = ''; viewTheme = ${JSON.stringify(theme)}; renderCodeFixture(${JSON.stringify(language)}, 'user')`);
    await until("!!document.querySelector('.message-row.user .message-actions')", 'user message actions render');
    await until(`!!document.querySelector('.message-row.user .message-actions button[title="${copyTitle}"]')`, 'localized copy action');
    await until('document.querySelectorAll(".user-bubble .markdown-content p code").length === 3', 'single and double backtick keywords render');
    const keywords = await run(`Array.from(document.querySelectorAll('.user-bubble .markdown-content p code'), node => {
      const style = getComputedStyle(node); return {text:node.textContent,background:style.backgroundColor,padding:parseFloat(style.paddingLeft),radius:parseFloat(style.borderRadius),weight:style.fontWeight};
    })`);
    assert.deepEqual(keywords.map(item => item.text), ['user_id', '包含 \`反引号\` 的关键词', '优先处理']);
    assert.ok(keywords.every(item => item.background !== 'rgba(0, 0, 0, 0)' && item.background !== 'transparent' && item.padding > 0 && item.radius > 0), 'user keywords have a visible theme-aware capsule');
    assert.equal(keywords[2].weight, '400', 'nested emphasis does not make code bold');
    assert.equal(await run('getComputedStyle(document.querySelector(".user-bubble pre code")).paddingLeft'), '0px', 'block code never inherits inline capsule padding');
    assert.equal(await run('document.querySelector(".user-bubble .markdown-content p code img")'), null, 'code stays literal');
    assert.ok(await run('document.querySelector(".user-bubble .markdown-content").textContent.includes("字面符号：`普通文本`；未闭合：`保留原文")'), 'escaped and unclosed backticks remain ordinary text');
    await run(`document.querySelector('.message-row.user .message-actions button[title="${copyTitle}"]').click()`);
    await until('copiedCode === codeFixtureContent', 'user copy preserves the complete input');
    await until(`codeCopyFeedback === ${feedbackBefore + 1}`, 'user copy signals success');
    const bounds = window.getBounds();
    window.setSize(360, 600);
    await until('innerWidth === 360', 'narrow user Markdown viewport');
    assert.ok(await run('(()=>{const bubble=document.querySelector(".user-bubble"),box=bubble.getBoundingClientRect();return bubble.scrollWidth<=bubble.clientWidth+1&&box.left>=0&&box.right<=innerWidth;})()'), 'keyword capsules fit a narrow user message');
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(root, 'tmp', `user-keywords-${theme}.png`), (await window.capturePage()).toPNG());
    window.setBounds(bounds);
  }

  for (const alias of ['c#', 'cs', 'CSharp', 'c++', 'pwsh', 'jsonc']) {
    const sample = alias === 'pwsh' ? '$value = Get-Process' : alias === 'jsonc' ? '// comment\n{"ok":true}' : 'int value = 42;';
    const content = `\`\`\`${alias}\n${sample}\n\`\`\``;
    await run(`renderView(h(views.MarkdownContent, { content: ${JSON.stringify(content)}, language: 'en' }))`);
    await until(`document.querySelector('pre code')?.textContent === ${JSON.stringify(sample + '\n')}`, `${alias} replaces the previous fixture`);
    await until("!!document.querySelector('code.syntax-highlighted .token')", `${alias} fence highlight`);
    assert.equal(await run("document.querySelector('pre code').textContent"), sample + '\n');
  }
  for (const [label, sample] of [['unknown-format', '<raw>&literal'], ['csharp', 'int x = 1;'.repeat(5000)]]) {
    const content = `\`\`\`${label}\n${sample}\n\`\`\``;
    await run(`renderView(h(views.MarkdownContent, { content: ${JSON.stringify(content)}, language: 'en' }))`);
    await until(`document.querySelector('pre code')?.textContent === ${JSON.stringify(sample + '\n')}`, 'lossless plain fallback');
    assert.equal(await run("document.querySelectorAll('code.syntax-highlighted').length"), 0, 'unknown and huge code use bounded plain rendering');
  }
  await run("preview('C:/fixture/Harness.cs')");
  await until("reads.some(read => read.path.endsWith('Harness.cs'))", 'C# file preview read');
  await run(`resolveReads('C:/fixture/Harness.cs', ${JSON.stringify(code)})`);
  await until("document.querySelector('.source-code-lines .token.keyword')?.textContent === 'for'", 'file preview uses the same C# grammar');
  assert.equal(await run("document.querySelectorAll('.source-code-line').length"), code.split('\n').length);
  await run('renderView(null)');
  await run("removeEventListener('cardbush-copy-feedback', onCodeCopyFeedback)");
  await window.webContents.removeInsertedCSS(sizing);
  console.log('Code rendering passed: actual media/code boundary, C# aliases and badges, both themes/languages, exact code/user/assistant copy and feedback, blank lines, wrap, large/unknown fallback and file preview.');
};
