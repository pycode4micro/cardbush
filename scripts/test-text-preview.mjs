import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decodeTextPreview, readTextPreview, renderTextFilePreview, maxPreviewBytes } = require('../dist-electron/textPreview.js');
const { readHandleBytes, readFilePrefix } = require('../dist-electron/fileRead.js');
const ts = require('typescript');
const rendererHelpers = { exports: {} };
new Function('module', 'exports', ts.transpileModule(
  await readFile(new URL('../src/shared/textPreview.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText)(rendererHelpers, rendererHelpers.exports);
const { shouldUsePlainTextPreview, textPreviewErrorMessage } = rendererHelpers.exports;

function encoded(text, encoding, bom = true) {
  if (encoding === 'utf-8') return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text)]);
  if (encoding.startsWith('utf-16')) {
    const bytes = Buffer.from((bom ? '\ufeff' : '') + text, 'utf16le');
    return encoding.endsWith('be') ? bytes.swap16() : bytes;
  }
  const points = [...(bom ? '\ufeff' : ''), ...text];
  const bytes = Buffer.alloc(points.length * 4);
  points.forEach((point, index) => encoding.endsWith('le')
    ? bytes.writeUInt32LE(point.codePointAt(0), index * 4)
    : bytes.writeUInt32BE(point.codePointAt(0), index * 4));
  return bytes;
}

test('previews UTF-8/16/32 without misclassifying code-unit zero padding', async t => {
  const text = '编码验证：中文😀\r\nline two\t& <markup>\rthird line';
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be', 'utf-32le', 'utf-32be']) {
    await t.test(encoding, () => {
      const result = decodeTextPreview(encoded(text, encoding), 'fixture.txt');
      assert.deepEqual(result, { content: text, encoding });
      assert.equal(decodeTextPreview(encoded('', encoding), 'empty.txt').content, '');
    });
  }
  assert.deepEqual(decodeTextPreview(Buffer.alloc(0), 'empty.txt'), { content: '', encoding: 'utf-8' });
  for (const encoding of ['utf-16le', 'utf-16be']) {
    assert.deepEqual(decodeTextPreview(encoded(text, encoding, false), 'fixture.log'), { content: text, encoding });
  }
  assert.equal(decodeTextPreview(Buffer.from('plain UTF-8 中文'), 'README').content, 'plain UTF-8 中文');
});

test('Unicode BOM is stripped for JSON/theme and Markdown consumers', () => {
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be', 'utf-32le', 'utf-32be']) {
    assert.deepEqual(JSON.parse(decodeTextPreview(encoded('{"name":"中文"}', encoding), 'style.json').content), { name: '中文' });
    assert.equal(decodeTextPreview(encoded('# 标题', encoding), 'README.md').content, '# 标题');
  }
});

test('legacy Chinese text has an explicit GB18030 fallback, without guessing for arbitrary binary', () => {
  const bytes = Buffer.from('c4e3bac30d0a', 'hex'); // GBK: 你好
  assert.deepEqual(decodeTextPreview(bytes, 'fixture.LOG'), { content: '你好\r\n', encoding: 'gb18030' });
  assert.throws(() => decodeTextPreview(bytes, 'fixture.bin'), /text_preview_encoding/);
  assert.throws(() => decodeTextPreview(Buffer.concat([encoded('', 'utf-8'), bytes]), 'fixture.txt'), /text_preview_encoding/, 'BOM must not be overridden by a legacy fallback');
});

test('preview limits do not introduce broken characters or silently hide errors inside the file', () => {
  const text = 'plain prefix 中文😀 ending';
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be', 'utf-32le', 'utf-32be']) {
    const bytes = encoded(text, encoding);
    for (let length = 12; length < bytes.length; length += 1) {
      const { content } = decodeTextPreview(bytes.subarray(0, length), 'fixture.txt', true);
      assert.ok(text.startsWith(content), `${encoding} at ${length} bytes must be an exact character prefix`);
      assert.ok(!content.includes('\ufffd'));
    }
  }
  assert.throws(() => decodeTextPreview(encoded('dangling \ud800', 'utf-16le'), 'bad.txt'), /text_preview_encoding/);
  assert.throws(() => decodeTextPreview(Buffer.from([0xef, 0xbb, 0xbf, 0xc3]), 'bad.txt'), /text_preview_encoding/);
  const invalidUtf32 = encoded('valid', 'utf-32be');
  invalidUtf32.writeUInt32BE(0x110000, 4);
  assert.throws(() => decodeTextPreview(invalidUtf32, 'bad.txt'), /text_preview_encoding/);
});

test('binary files cannot bypass the guard by being renamed txt or having a Unicode BOM', () => {
  for (const hex of ['89504e470d0a1a0a', '504b0304', '255044462d312e37', '1f8b0800']) {
    assert.throws(() => decodeTextPreview(Buffer.from(hex, 'hex'), 'renamed.txt'), /text_preview_binary/);
  }
  assert.throws(() => decodeTextPreview(Buffer.alloc(100), 'zeros.txt'), /text_preview_binary/);
  assert.throws(() => decodeTextPreview(encoded('hello\0world', 'utf-16le'), 'binary.txt'), /text_preview_binary/);
  assert.throws(() => decodeTextPreview(Buffer.from([1, 2, 3, 4]), 'control.txt'), /text_preview_binary/);
});

test('short reads are accumulated and EOF never exposes unread buffer contents', async () => {
  const source = Buffer.from('prefix:actual-tail');
  const positions = [];
  const handle = {
    async read(bytes, offset, length, position) {
      positions.push(position);
      const bytesRead = Math.min(2, length, Math.max(0, source.length - position));
      source.copy(bytes, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
  assert.equal((await readHandleBytes(handle, 100, 7)).toString(), 'actual-tail');
  assert.deepEqual(positions, [7, 9, 11, 13, 15, 17, 18]);
});

test('local file protocol serves only actual bytes when files shrink during preview reads', async () => {
  // Exercise the production handler without starting Electron or touching user files.
  const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ['registerLocalFileProtocol', 'byteRangeFromHeader'].map(name => {
    const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, name);
    return declaration.getText(parsed);
  }).join('\n');
  let handler;
  let actual = Buffer.from('short');
  let openSize = 5;
  let closeCount = 0;
  const stats = size => ({ size, isFile: () => true });
  const bindings = {
    protocol: { isProtocolHandled: () => false, handle: (_scheme, callback) => { handler = callback; } },
    localFileProtocol: 'cardbush-file',
    fs: { promises: {
      stat: async () => stats(12),
      readFile: async () => actual,
      open: async () => {
        let reads = 0;
        return {
          stat: async () => stats(reads ? actual.length : openSize),
          read: async (buffer, offset, length, position) => {
            reads += 1;
            const bytesRead = Math.min(2, length, Math.max(0, actual.length - position));
            actual.copy(buffer, offset, position, position + bytesRead);
            return { bytesRead };
          },
          close: async () => { closeCount += 1; },
        };
      },
    } },
    normalizeShellPath: value => value,
    localPathFromProtocolUrl: () => 'fixture.txt',
    contentTypeForPath: () => 'text/plain',
    isHighFidelityOfficePreviewPath: () => true,
    readHandleBytes,
  };
  new Function(...Object.keys(bindings), ts.transpileModule(functions + '\nregisterLocalFileProtocol();', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)(...Object.values(bindings));
  const request = (range, method = 'GET', host = 'file') => handler({
    url: `cardbush-file://${host}/fixture.txt?path=fixture.txt`, method,
    headers: new Headers(range ? { range } : {}),
  });
  for (openSize of [5, 12]) {
    const response = await request('bytes=0-11');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-length'), '5');
    assert.equal(response.headers.get('content-range'), 'bytes 0-4/5');
    assert.equal(await response.text(), 'short');
  }
  openSize = 5;
  const missingRange = await request('bytes=7-11');
  assert.equal(missingRange.status, 416);
  assert.equal(missingRange.headers.get('content-range'), 'bytes */5');
  const head = await request('bytes=0-11', 'HEAD');
  assert.equal(head.headers.get('content-length'), '5');
  assert.equal(await head.text(), '');
  for (const host of ['file', 'office-source']) {
    const full = await request(null, 'GET', host);
    assert.equal(full.headers.get('content-length'), '5');
    assert.equal(await full.text(), 'short');
  }
  actual = Buffer.alloc(0);
  const emptied = await request('bytes=0-11');
  assert.equal(emptied.status, 416);
  assert.equal(emptied.headers.get('content-range'), 'bytes */0');
  assert.equal(closeCount, 5, 'every opened handle is closed, including empty ranges');
});

test('large previews avoid unbounded parsing/DOM work, with CRLF counted once', () => {
  assert.equal(shouldUsePlainTextPreview('normal code'), false);
  assert.equal(shouldUsePlainTextPreview('x\r\n'.repeat(3999)), false);
  assert.equal(shouldUsePlainTextPreview('x\r'.repeat(4000)), true);
  assert.equal(shouldUsePlainTextPreview('x\n'.repeat(4000)), true);
  assert.equal(shouldUsePlainTextPreview('x'.repeat(10000)), false);
  assert.equal(shouldUsePlainTextPreview('x'.repeat(10001)), true);
  assert.equal(shouldUsePlainTextPreview('x'.repeat(1000).concat('\n').repeat(201)), true);
  assert.match(textPreviewErrorMessage(new Error('IPC failure [text_preview_binary]'), 'zh'), /二进制/);
  assert.match(textPreviewErrorMessage(new Error('IPC failure [text_preview_encoding]'), 'zh'), /编码/);
  assert.equal(textPreviewErrorMessage(new Error('Unexpected real failure'), 'en'), 'Unexpected real failure');
});

test('real filesystem previews share decoding, truncation, directory rejection and escaped HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-text-preview-'));
  try {
    const target = join(directory, '中文 test-final.txt');
    const text = '测试结果：通过\n</pre><script>throw "unsafe"</script>';
    const bytes = encoded(text, 'utf-16le');
    await writeFile(target, bytes);
    const preview = await readTextPreview(target);
    assert.equal(preview.content, text);
    assert.equal(preview.encoding, 'utf-16le');
    assert.equal(preview.truncated, false);
    assert.equal(preview.size, bytes.length);
    assert.equal((await readFilePrefix(target, bytes.length + 100)).length, bytes.length);
    const html = await renderTextFilePreview(target, '<img src=x onerror=alert(1)>');
    assert.ok(html.includes('测试结果：通过'));
    assert.ok(html.includes('&lt;/pre&gt;&lt;script&gt;'));
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes('UTF-16LE'));
    assert.doesNotMatch(html, /<script>|<img/);
    assert.deepEqual(await readFile(target), bytes, 'preview must not transcode the original file');
    await assert.rejects(readTextPreview(directory), /not a file/);
    await assert.rejects(readTextPreview(join(directory, 'missing.txt')), { code: 'ENOENT' });
    await writeFile(target, Buffer.from([0, 0, 0, 0]));
    await assert.rejects(readTextPreview(target), /text_preview_binary/);
    assert.match(await renderTextFilePreview(target), /十六进制数据/);

    for (const encoding of ['utf-8', 'utf-16le']) {
      const bomLength = encoding === 'utf-8' ? 3 : 2;
      const unitBytes = encoding === 'utf-8' ? 1 : 2;
      const prefix = 'a'.repeat((maxPreviewBytes - bomLength - (encoding === 'utf-8' ? 1 : 2)) / unitBytes);
      await writeFile(target, encoded(prefix + '😀end', encoding));
      const bounded = await readTextPreview(target);
      assert.equal(bounded.content, prefix);
      assert.equal(bounded.truncated, true);
      assert.equal(bounded.encoding, encoding);
    }
    await writeFile(target, Buffer.alloc(maxPreviewBytes, 0x61));
    assert.equal((await readTextPreview(target)).truncated, false, 'exact limit is not truncated');
  } finally {
    await rm(directory, { recursive: true, force: true }); // only this owned mkdtemp fixture
  }
});
