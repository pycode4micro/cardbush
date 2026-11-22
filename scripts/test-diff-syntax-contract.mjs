import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const { diffBlocks, diffLanguageForPath, diffLineNumbers, diffLinePrefix, diffLineSource, shouldVirtualizeDiff } = await loadChatTranscript({
  source: `export * from ${JSON.stringify(path.resolve('src/features/tools/diffSyntax.ts'))};`,
});

assert.equal(diffLanguageForPath('src/App.tsx'), 'tsx');
assert.equal(diffLanguageForPath('backend/models.py'), 'python');
assert.equal(diffLanguageForPath('C:\\repo\\package.json'), 'json');
assert.equal(diffLanguageForPath('README.md'), 'markdown');
assert.equal(diffLanguageForPath('unknown.binary'), 'plain');
assert.equal(diffLinePrefix({ kind: 'addition', text: '+const ready = true;' }), '+');
assert.equal(diffLinePrefix({ kind: 'deletion', text: '-const ready = false;' }), '-');
assert.equal(diffLineSource({ kind: 'addition', text: '+const ready = true;' }), 'const ready = true;');
assert.equal(diffLineSource({ kind: 'context', text: '  return ready;' }), ' return ready;');
assert.equal(diffLineSource({ kind: 'hunk', text: '@@ -1,2 +1,2 @@' }), '@@ -1,2 +1,2 @@');
assert.deepEqual(
  JSON.parse(JSON.stringify(diffLineNumbers([
    { kind: 'hunk', text: '@@ -8,3 +11,4 @@' },
    { kind: 'context', text: ' const stable = true;' },
    { kind: 'deletion', text: '-const before = 1;' },
    { kind: 'addition', text: '+const after = 2;' },
    { kind: 'addition', text: '+const extra = 3;' },
  ]))),
  [
    { oldLine: null, newLine: null },
    { oldLine: 8, newLine: 11 },
    { oldLine: 9, newLine: null },
    { oldLine: null, newLine: 12 },
    { oldLine: null, newLine: 13 },
  ],
);

const codeLine = { kind: 'addition', text: '+.selector { display: block; }' };
const largeDiff = [...Array(3_392).fill(codeLine), { ...codeLine, text: '+' + 'x'.repeat(8_000) }, codeLine];
assert.equal(shouldVirtualizeDiff([codeLine]), false);
assert.equal(shouldVirtualizeDiff(largeDiff), true);
assert.equal(shouldVirtualizeDiff(largeDiff.slice(-2)), true);
const blocks = diffBlocks(largeDiff);
assert.equal(blocks[0].start, 0);
assert.equal(blocks.at(-1).end, largeDiff.length);
for (const [index, block] of blocks.entries()) {
  if (index > 0) assert.equal(block.start, blocks[index - 1].end);
  assert.ok(block.end - block.start <= 24);
  if (block.highlight) assert.ok(largeDiff.slice(block.start, block.end).reduce((size, line) => size + line.text.length + 1, 0) <= 12_000);
}
assert.deepEqual({ ...blocks.at(-2) }, { start: 3_392, end: 3_393, highlight: false });

const renderer = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolChangeBlock.tsx'),
  'utf8',
);
assert.match(renderer, /\(\) => import\('\.\/DiffSyntaxLines'\)/);
assert.match(renderer, /<Suspense fallback=\{<DiffRows/);

const highlightedDiff = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'DiffSyntaxLines.tsx'),
  'utf8',
);
const highlightedSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'SourceSyntaxLines.tsx'),
  'utf8',
);
const diffRows = fs.readFileSync(path.join(process.cwd(), 'src', 'features', 'tools', 'DiffRows.tsx'), 'utf8');
assert.match(highlightedDiff, /<DiffRows \{\.\.\.rows\}/);
assert.match(diffRows, /className="diff-line-number old"/);
assert.match(diffRows, /className="diff-line-number new"/);
assert.match(highlightedSource, /className="source-line-number"/);
assert.match(highlightedSource, /diffLanguageForPath\(path\)/);

console.log('diff syntax highlighting contract tests passed');
