import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Script, runInNewContext } from 'node:vm';
import { renderHtmlTemplate } from '@cardbush/platform/templates';
import { renderTextFilePreview } from '../dist-electron/textPreview.js';
import { renderOfficePreview } from '../dist-electron/officePreview.js';
import { startOpenAiLogin } from '@cardbush/bush-mcp-client';

test('packaged templates escape text once, preserve literal slots and reject incomplete input', () => {
  const values = { language: 'en', title: '<script>alert(1)</script>', path: '" onload="alert(1)', notice: '& {{text:content}}', content: '<img src=x onerror=alert(1)>' };
  const html = renderHtmlTemplate('text-preview', values);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot; onload=&quot;alert(1)'));
  assert.ok(html.includes('&amp; {{text:content}}'), 'interpolated values are never recursively evaluated');
  assert.ok(!html.includes('<img src=x'));
  assert.throws(() => renderHtmlTemplate('text-preview', { language: 'en' }), /Missing/);
  assert.throws(() => renderHtmlTemplate('text-preview', { ...values, extra: 'unexpected' }), /Unexpected/);
  assert.throws(() => renderHtmlTemplate('__proto__', {}), /Unknown/);
  const require = createRequire(import.meta.url);
  assert.equal(require('@cardbush/platform/templates').renderHtmlTemplate('text-preview', values), html,
    'CJS Electron and ESM services ship the same template resources');
});

test('native previews render both languages concurrently and preserve hostile file content as text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-template-test-'));
  try {
    const file = join(directory, 'sample.txt');
    await writeFile(file, '<script>window.compromised = true</script> & {{text:title}}');
    const [english, chinese] = await Promise.all([renderTextFilePreview(file, '', 'en'), renderTextFilePreview(file, '', 'zh')]);
    assert.match(english, /lang="en"/); assert.match(english, /Text preview/);
    assert.match(chinese, /lang="zh"/); assert.match(chinese, /文本预览/);
    assert.ok(english.includes('&lt;script&gt;window.compromised'));
    const [en, zh] = await Promise.all([renderOfficePreview(join(directory, 'sample.unknown'), 'en'), renderOfficePreview(join(directory, 'sample.unknown'), 'zh')]);
    assert.match(en, /Read-only preview/); assert.match(en, /Fit width/);
    assert.doesNotMatch(en, /[\u3400-\u9fff]/);
    assert.match(zh, /只读预览/); assert.match(zh, /适应宽度/);
    for (const html of [en, zh]) for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('script templates preserve translated punctuation and reject HTML script breakout', () => {
  const hostile = "Quotation '\" \\ newline\n</script><script>compromised=true</script>\u2028";
  const statuses = [];
  const script = renderHtmlTemplate('office-reader-script', {
    readerKind: 'workbook', sheetNumber: hostile, slideNumber: hostile,
    gridHidden: hostile, gridShown: hostile, formulaHidden: hostile, formulaShown: hostile,
  });
  assert.doesNotMatch(script, /<\/script/i);
  const sheet = {};
  runInNewContext(script, {
    document: {
      documentElement: { style: { setProperty() {} } },
      querySelector: () => null,
      querySelectorAll: selector => selector === '[data-sheet]' ? [sheet] : selector === '.office-status' ? [{ set textContent(value) { statuses.push(value); } }] : [],
      addEventListener() {},
    },
    window: { dispatchEvent() {} }, Event: class {},
  });
  assert.ok(statuses.includes(hostile));
  assert.equal(sheet.hidden, false);
  new Script(renderHtmlTemplate('office-docx-script', { base64: '', pageCount: hostile, failureHeading: hostile }));
});

test('OAuth callback pages use the selected language without exposing callback parameters', async () => {
  for (const [language, expected] of [['en', 'Login state validation failed'], ['zh', '登录状态校验失败']]) {
    const login = await startOpenAiLogin({ language, ports: [0], timeoutMs: 5000 });
    try {
      const callback = new URL(login.redirectUri);
      callback.searchParams.set('state', '<script>alert(1)</script>');
      const response = await fetch(callback);
      assert.equal(response.status, 400);
      const html = await response.text();
      assert.ok(html.includes(expected)); assert.ok(!html.includes('alert(1)'));
      assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    } finally { await login.close(); await login.result.catch(() => {}); }
  }
});
