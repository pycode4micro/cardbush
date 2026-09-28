import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const api = await loadChatTranscript({
  conditions: ['node'],
  source: [
    'src/shared/codeLanguages.ts', 'src/shared/syntaxPrism.ts',
    'src/features/chatMessages/FileTypeIcon.tsx', 'src/features/messageImages.ts',
    'src/features/chatMessages/markdownFormat.ts',
  ].map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'),
  globals: { process: { env: { NODE_ENV: 'production' } } },
});

test('every advertised language and alias has a registered grammar', () => {
  for (const language of api.codeLanguages) {
    assert.ok(api.Prism.languages[language.grammar], `${language.id} grammar loaded`);
    for (const alias of [language.id, ...language.aliases]) {
      assert.equal(api.codeLanguageForFence(alias.toUpperCase())?.id, language.id);
    }
  }
  for (const alias of ['cs', 'c#', 'csharp', 'CSharp']) {
    assert.equal(api.codeLanguageLabel(alias, 'zh'), 'C#');
    assert.equal(api.codeLanguageForFence(alias).grammar, 'csharp');
  }
  assert.equal(api.codeLanguageLabel('text', 'zh'), '纯文本');
  assert.equal(api.codeLanguageLabel('text', 'en'), 'Plain text');
  assert.equal(api.codeLanguageForFence('unknown-language'), undefined);
});

test('common languages produce real tokens, including the unsafe C# loop', () => {
  const samples = {
    csharp: 'for (int p = 0; p < _w; p++) { byte* s = src + p*4; byte* dd = d + p*3; dd[0]=s[0]; }',
    fsharp: 'let square x = x * x', vbnet: 'Dim value As Integer = 42',
    java: 'public class Example { private int value = 1; }',
    php: '<?php echo "hello"; ?>', ruby: 'def greet(name)\n puts name\nend',
    dart: 'final String name = "test";', lua: 'local x = true',
    powershell: '$value = Get-Process | Select-Object Name', bash: 'echo "hello $USER"',
    json5: '// comment\n{ foo: 1 }', toml: '[package]\nname = "example"',
    yaml: 'name: example\nready: true', docker: 'FROM node:24\nRUN npm ci',
    sql: 'SELECT name FROM users WHERE id = 1;', hcl: 'variable "name" { default = "test" }',
    typescript: 'const name: string = "test";', python: 'def greet():\n    return "hello"',
  };
  for (const [language, source] of Object.entries(samples)) {
    const tokens = api.Prism.tokenize(source, api.Prism.languages[language]);
    assert.ok(tokens.some(token => typeof token !== 'string'), `${language} is not plain text`);
    const content = token => typeof token === 'string' ? token : Array.isArray(token) ? token.map(content).join('') : content(token.content);
    assert.equal(content(tokens), source, `${language} tokenization preserves all source`);
  }
});

test('file extensions, dotfiles, special names and module variants share language detection', () => {
  const cases = {
    'Harness.cs': 'csharp', 'script.CSX': 'csharp', 'types.fsi': 'fsharp', 'Form.vb': 'vbnet',
    'component.axaml': 'markup', 'project.csproj': 'markup', 'image.svg': 'markup',
    'module.cjs': 'javascript', 'module.cts': 'typescript', 'types.pyi': 'python',
    'setup.psm1': 'powershell', 'config.psd1': 'powershell', '.zshrc': 'bash',
    '.env.local': 'ini', 'Dockerfile.dev': 'docker', 'Containerfile': 'docker',
    'CMakeLists.txt': 'cmake', 'Makefile': 'makefile', 'Gemfile': 'ruby',
    'Cargo.toml': 'toml', 'settings.jsonc': 'json5', 'main.tf': 'hcl', 'schema.proto': 'protobuf',
  };
  for (const [file, grammar] of Object.entries(cases)) {
    assert.equal(api.codeLanguageForPath(`C:\\repo\\${file}`).grammar, grammar, file);
  }
  assert.equal(api.codeLanguageForPath('https://example.com/Program.cs?raw=1').grammar, 'csharp');
  assert.equal(api.codeLanguageForPath('file:///C:/project/Program.cs').grammar, 'csharp');
  assert.equal(api.codeLanguageForPath('archive.unsupported'), undefined);
  assert.equal(api.normalizeMarkdownContentForDisplay('```harn/Harness.cs\n```'), '```text\nharn/Harness.cs\n```');
  assert.equal(api.normalizeMarkdownContentForDisplay('```c#\nint x = 1;\n```'), '```c#\nint x = 1;\n```');
});

test('common source, project, configuration and binary formats get distinct icons', () => {
  const cases = {
    'Harness.cs': 'csharp', 'sample.csx': 'csharp', 'main.cpp': 'cpp', 'main.c': 'c',
    'main.fs': 'fsharp', 'main.vb': 'vbnet', 'main.dart': 'dart', 'main.lua': 'lua',
    'main.r': 'r', 'types.pyi': 'python', 'main.cjs': 'javascript', 'main.cts': 'typescript',
    'page.tsx': 'typescript-react', 'page.jsx': 'javascript-react',
    'project.csproj': 'config', 'app.sln': 'config', 'settings.toml': 'config', '.env.local': 'config',
    '.gitignore': 'config', 'settings.yaml': 'config', 'settings.jsonc': 'json', 'data.jsonl': 'json',
    'Dockerfile.dev': 'package', 'Makefile': 'config', 'setup.ps1': 'terminal', 'profile.psm1': 'terminal',
    'photo.heic': 'image', 'photo.tiff': 'image', 'image.svg': 'image', 'clip.mkv': 'video',
    'sound.flac': 'audio', 'table.parquet': 'database', 'data.xlsx': 'sheet', 'deck.pptm': 'slides',
    'report.pdf': 'document', 'document.docx': 'document', 'LICENSE': 'document', 'README': 'document',
    'archive.tar.zst': 'archive', 'font.woff2': 'font', 'scene.glb': 'model', 'certificate.pfx': 'certificate',
    'app.msix': 'package', 'app.exe': 'package', 'app.AppImage': 'package',
  };
  for (const [path, tone] of Object.entries(cases)) assert.equal(api.fileTypeDescriptor(path).tone, tone, path);
  assert.equal(api.fileTypeDescriptor('file:///C:/code/Harness.CS').label, 'C#');
  assert.equal(api.fileTypeDescriptor('https://example.com/Harness.cs?download=1').tone, 'csharp');
  assert.equal(api.fileTypeDescriptor('unknown.extension').tone, 'generic');
});

test('standalone media extraction never splits code fences or consumes code samples', () => {
  const content = [
    '复现材料：', '```', 'C:\\work\\mjpeg-out.png', '第 4 段实际全黑', '```', '',
    '修法是把两层循环并成按像素的一层：', '', '```csharp', 'for (int p = 0; p < _w; p++) { }', '```',
  ].join('\n');
  const blocks = api.splitMessageMediaBlocks(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, content);
  assert.equal(api.splitMessageMedia(content).imagePaths.length, 0);
  assert.equal(api.normalizeMarkdownContentForDisplay(blocks[0].content), content);
  for (const code of [
    '~~~text\nC:/work/a.png\n~~~', '````md\n```\nC:/work/a.png\n```\n````',
    '```csharp\nC:/work/a.png', '    C:/work/a.png', '\tC:/work/a.png', '`C:/work/a.png`',
    '```text\n~~~\nC:/work/a.png\n```', '```text\n```fake-close\nC:/work/a.png\n```',
  ]) {
    assert.equal(api.splitMessageMediaBlocks(code).length, 1);
    assert.equal(api.splitMessageMediaBlocks(code)[0].content, code);
    assert.equal(api.splitMessageMedia(code).imagePaths.length, 0);
  }
  const mixed = api.splitMessageMediaBlocks(`${content}\n\nC:/work/result.png\n完成。`);
  assert.equal(mixed.length, 3);
  assert.equal(mixed[0].content, content);
  assert.equal(mixed[1].items[0].path, 'C:/work/result.png');
  assert.equal(mixed[2].content, '完成。');
});
