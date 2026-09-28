const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, window, root }) => {
  const code = 'for (int p = 0; p < _w; p++) {\n    byte* s = src + p*4;\n\n    byte* dd = d + p*3; dd[0]=s[0];\n}\n';
  const content = [
    '复现结果：', '```', 'C:/fixture/mjpeg-out.png', '第 4 段实际全黑', '```', '',
    '修法是把两层循环并成按像素的一层：', '', '```csharp', code.trimEnd(), '```', '',
    '复现材料：`harn/MjpegTailHarness.cs`、`src/Sample.fs`、`src/main.cpp`、`config/settings.toml`。',
  ].join('\n');
  await run(`
    window.codeFixtureContent = ${JSON.stringify(content)};
    window.renderCodeFixture = (language = 'zh') => renderView(
      h(views.MessageFileReferenceScope, { workspaceRoot: 'C:/fixture' },
        h(views.MessageBubble, { language, sending: false, activeTurnId: '', activeAssistantMessageId: '', message: {
          id: 'code-fixture', role: 'assistant', status: 'completed', content: codeFixtureContent,
          metadata: { transcript_kind: 'assistant_final' } } })));
    window.copiedCode = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copiedCode = text; } } });
    renderCodeFixture();
  `);
  for (const [theme, language] of [['theme-dark', 'zh'], ['theme-light', 'en']]) {
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
    await run(`document.querySelectorAll('.markdown-code-block')[1].querySelector('button[title="${copyTitle}"]').click()`);
    await until(`copiedCode === ${JSON.stringify(code)}`, 'copy contains exact source without labels');
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

  for (const alias of ['c#', 'cs', 'CSharp', 'c++', 'pwsh', 'jsonc']) {
    const sample = alias === 'pwsh' ? '$value = Get-Process' : alias === 'jsonc' ? '// comment\n{"ok":true}' : 'int value = 42;';
    const content = `\`\`\`${alias}\n${sample}\n\`\`\``;
    await run(`renderView(h(views.MarkdownContent, { content: ${JSON.stringify(content)}, language: 'en' }))`);
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
  console.log('Code rendering passed: actual media/code boundary, C# aliases and badges, both themes/languages, exact copy, blank lines, wrap, large/unknown fallback and file preview.');
};
