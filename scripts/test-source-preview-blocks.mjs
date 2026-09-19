import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/features/tools/sourcePreviewBlocks.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { sourcePreviewBlocks, shouldVirtualizeSource } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));

test('ordinary source files switch to windowed rendering before allocating thousands of rows', () => {
  assert.equal(shouldVirtualizeSource('const small = 1;'), false);
  assert.equal(shouldVirtualizeSource('x\n'.repeat(300)), true);
  assert.equal(shouldVirtualizeSource('x'.repeat(4097)), true);
  assert.equal(shouldVirtualizeSource(('x'.repeat(2000) + '\n').repeat(20)), true);
});

test('visible source blocks retain every character and logical line, including long Unicode lines', () => {
  for (const content of ['', 'a\r\nb\rc\n', 'const a = 1;\n'.repeat(24000),
    'x'.repeat(4095) + '😀'.repeat(10000) + '\nlast', 'a'.repeat(2 * 1024 * 1024)]) {
    const blocks = sourcePreviewBlocks(content);
    const rows = blocks.flatMap(block => block.rows);
    const restored = [];
    for (const row of rows) restored[row.line - 1] = (restored[row.line - 1] ?? '') + row.text;
    assert.equal(restored.join('\n'), content.replace(/\r\n?/g, '\n'));
    assert.ok(blocks.every(block => block.rows.length <= 40));
    assert.ok(blocks.every(block => block.rows.reduce((sum, row) => sum + row.text.length, 0) <= 12000));
    assert.ok(rows.every(row => row.text.length <= 4096));
    assert.ok(rows.every(row => !/[\ud800-\udbff]$/.test(row.text) && !/^[\udc00-\udfff]/.test(row.text)));
    assert.ok(blocks.filter(block => block.rows.some(row => row.continuation)).every(block => !block.highlight));
  }
});
