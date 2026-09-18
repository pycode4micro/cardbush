import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const syntax = load('src/features/tools/diffSyntax.ts');
const { reviewAnchor, reviewRevision, appendReviewCommentsToDraft } = load('src/features/sidebar/reviewCommentModel.ts', { '../tools/diffSyntax': syntax });
const lines = [
  { kind: 'hunk', text: '@@ -50,2 +70,3 @@' },
  { kind: 'deletion', text: '-old' }, { kind: 'addition', text: '+new' },
  { kind: 'addition', text: '+extra' }, { kind: 'context', text: ' unchanged' },
];
const revision = reviewRevision(lines);
const at = (index, side, extend) => reviewAnchor(lines, 'C:/项目/a.ts', 'turn-2', revision, index, side, extend);

test('comment anchors distinguish deleted and added lines with real hunk offsets', () => {
  assert.equal(at(0, 'new'), null, 'hunk headers cannot be commented as code');
  assert.equal(at(1, 'new'), null, 'deleted code cannot be attached to the new side');
  assert.deepEqual([at(1, 'old').startLine, at(2, 'new').startLine], [50, 70]);
  const range = at(3, 'new', at(2, 'new'));
  assert.deepEqual([range.startLine, range.endLine, range.excerpt], [70, 71, 'new\nextra']);
  assert.equal(at(3, 'new', { ...range, turnId: 'turn-1' }).startLine, 71, 'ranges cannot silently span turns');
  assert.equal(at(4, 'old').startLine, 51);
  assert.equal(at(4, 'new').startLine, 72);
});

test('changed versions do not reuse an old comment position and excerpts stay bounded', () => {
  assert.equal(reviewRevision(lines.map(line => ({ ...line }))), revision);
  assert.notEqual(reviewRevision([...lines.slice(0, 2), { kind: 'addition', text: '+changed' }, ...lines.slice(3)]), revision);
  const large = [{ kind: 'addition', text: '+' + 'x'.repeat(200000) }];
  const anchor = reviewAnchor(large, 'file', 'turn', reviewRevision(large), 0, 'new');
  assert.ok(anchor.excerpt.length < 4100);
  assert.equal('lines' in anchor, false, 'comments do not retain file snapshots');
});

test('composing comments preserves user text, version/side, Unicode paths and exact code context', () => {
  const comments = [{ ...at(1, 'old'), id: 'old', text: '保留兼容' }, { ...at(3, 'new', at(2, 'new')), id: 'new', text: '合并两行' }];
  const draft = appendReviewCommentsToDraft('已有要求', comments, 'zh');
  for (const fragment of ['已有要求\n\n', 'C:/项目/a.ts', 'L50', 'R70–R71', 'turn-2', '保留兼容', '    new\n    extra']) assert.ok(draft.includes(fragment), fragment);
  assert.equal(appendReviewCommentsToDraft('已有要求\n', [], 'zh'), '已有要求\n');
});
