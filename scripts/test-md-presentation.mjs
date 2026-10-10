import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
const require = createRequire(import.meta.url);
function module(path, deps = {}) {
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports, id => deps[id] ?? require(id));
  return exports;
}
const graph = module('src/features/mdPresentation/markdownGraph.ts');
const page = module('src/features/mdPresentation/pageDocument.ts');
test('page title and body editing preserve metadata, heading content and Team sections', () => {
  const document = { attributes: { name: '旧标题', author: '作者', team: { id: 'one' } }, introduction: '# 旧标题\n\n## 理由\n\n解释。', nodes: [{ id: 'task', attributes: { agent_id: 'worker' }, body: '任务' }] };
  const renamed = page.changePageTitle(document, '新标题');
  assert.equal(renamed.introduction, '# 新标题\n\n## 理由\n\n解释。');
  assert.deepEqual(renamed.nodes, document.nodes); assert.equal(renamed.attributes.author, '作者');
  const edited = page.changePageBody(renamed, '直接写正文。');
  assert.equal(edited.introduction, '# 新标题\n\n直接写正文。');
  assert.deepEqual(page.pageTitle(edited), { title: '新标题', body: '直接写正文。' });
  assert.equal(page.changePageTitle(edited, '').introduction, '直接写正文。');
});
const { teamToMarkdown, teamFromMarkdown, enableDocumentTeam } = module('src/features/team/teamMarkdown.ts', { '@cardbush/bush-protocol': protocol, '../mdPresentation/markdownGraph': graph });
const execution = ({ presentation, ...team }) => team;
const { MarkdownFiles } = module('electron/mdPresentationFiles.ts');
const workflow = protocol.teamWorkflowSchema.parse({ id: 'order', name: '订单核验', description: '先核验，再汇总。', max_parallel: 2, nodes: [
  { id: 'stock', name: '库存', agent_id: 'warehouse', prompt: '## 检查\n请核对库存。\n\n````md\n## example\n```md-node\nnot a node\n```\n````', position: { x: 140, y: 200 } },
  { id: 'check', agent_id: 'reviewer', prompt: '返回订单检查结果。', depends_on: ['stock'] },
] });

test('Team round trips Markdown, positions, assignments and DAG without a second execution format', () => {
  const text = teamToMarkdown(workflow);
  assert.ok(text.includes('depends_on:'));
  assert.ok(text.includes('# 订单核验'));
  assert.deepEqual(execution(teamFromMarkdown(text)), workflow);
  const document = graph.parseMarkdownGraph(text);
  assert.equal(document.nodes.length, 2);
  assert.deepEqual(graph.nodeLinks(document.nodes[0]), []);
  assert.deepEqual(graph.nodeDependencies(document.nodes[1]), ['stock']);
});
test('graph edits and Markdown edits share links; rename updates aliases but not code examples', () => {
  let document = graph.parseMarkdownGraph(teamToMarkdown(workflow));
  document.nodes[1].body += '\n文字 [[#stock|库存检查]]\n`[[#stock]]`\n\\[[#stock]]\n~~~md\n[[#absent]]\n~~~';
  document = graph.renameNode(document, 'stock', 'inventory');
  assert.deepEqual(graph.nodeDependencies(document.nodes[1]), ['inventory']);
  assert.ok(document.nodes[1].body.includes('[[#inventory|库存检查]]'));
  assert.ok(document.nodes[1].body.includes('`[[#stock]]`'));
  assert.ok(document.nodes[1].body.includes('\\[[#stock]]'));
  document = graph.removeNode(document, 'inventory');
  assert.deepEqual(graph.nodeDependencies(document.nodes[0]), []);
  assert.throws(() => graph.renameNode(document, 'check', '../outside'));
});
test('Team validates cycles, missing nodes, invalid employees and visual metadata at save boundary', () => {
  const document = graph.parseMarkdownGraph(teamToMarkdown(workflow));
  document.nodes[0] = graph.setNodeDependency(document.nodes[0], 'check', true);
  assert.throws(() => teamFromMarkdown(graph.writeMarkdownGraph(document)), /acyclic/);
  document.nodes[0] = graph.setNodeDependency(document.nodes[0], 'check', false);
  document.nodes[1] = graph.setNodeDependency(document.nodes[1], 'missing', true);
  assert.throws(() => teamFromMarkdown(graph.writeMarkdownGraph(document)), /acyclic/);
  document.nodes[1] = graph.setNodeDependency(document.nodes[1], 'missing', false);
  document.nodes[1].attributes.agent_id = '';
  assert.throws(() => teamFromMarkdown(graph.writeMarkdownGraph(document)));
  document.nodes[1].attributes.agent_id = 'reviewer'; document.nodes[1].attributes.position = { x: Infinity, y: 0 };
  assert.throws(() => teamFromMarkdown(graph.writeMarkdownGraph(document)));
});
test('plain Markdown stays intact; invalid metadata is explicit and cannot silently become an empty workflow', () => {
  const text = '# Notes\n\n## Ordinary heading\n\nContent and [[#other]].\n';
  assert.equal(graph.writeMarkdownGraph(graph.parseMarkdownGraph(text)), text);
  assert.throws(() => graph.parseMarkdownGraph('---\nname: example'), /Unclosed/);
  assert.throws(() => graph.parseMarkdownGraph('## a\n```md-node\nname: a'), /Unclosed/);
  assert.throws(() => graph.parseMarkdownGraph('---\nx: &self\n  child: *self\n---'), /aliases/);
  assert.throws(() => graph.parseMarkdownGraph('x'.repeat(graph.MAX_MARKDOWN_LENGTH + 1)), /2 MB/);
  assert.throws(() => teamFromMarkdown(text));
});
test('layout is stable and handles cyclic notes independently of Team DAG validation', () => {
  const nodes = [{ id: 'a', attributes: {}, body: '[[#b]]' }, { id: 'b', attributes: {}, body: '[[#a]]' }];
  assert.deepEqual(graph.layoutNodes(nodes, true), graph.layoutNodes(nodes, true));
  assert.equal(graph.layoutNodes(nodes).size, 2);
});

test('bush-it documents retain rationale, ordinary notes and metadata across Team conversion', () => {
  const document = graph.parseMarkdownGraph(teamToMarkdown(workflow));
  document.introduction = '# 订单核验\n\n## 为什么这样做\n\n' + '完整的背景与依据。'.repeat(800);
  document.attributes.author = 'Document author';
  document.nodes.unshift({ id: 'rationale', attributes: { name: '思考与备忘', tags: ['notes'] }, body: '这不是一项任务。\n\n[[#check]]' });
  document.nodes[1].body += '\n\n参考 [[#rationale]] 和 [[#check]]。';
  const source = graph.writeMarkdownGraph(document), team = teamFromMarkdown(source);
  assert.equal(team.nodes.length, 2, 'ordinary sections are not executable nodes');
  assert.deepEqual(team.nodes[0].depends_on, [], 'citations never schedule a task or create a cycle');
  assert.equal(team.presentation.markdown, source);
  const restored = graph.parseMarkdownGraph(teamToMarkdown(team));
  assert.equal(restored.introduction, document.introduction);
  assert.equal(restored.attributes.author, 'Document author');
  assert.deepEqual(restored.nodes[0], document.nodes[0]);
  assert.deepEqual(execution(teamFromMarkdown(teamToMarkdown(team))), execution(team));
});

test('runtime edits update execution fields while retaining the surrounding bush-it document', () => {
  const document = graph.parseMarkdownGraph(teamToMarkdown(workflow));
  document.introduction = '# 协作说明\n\n保留背景、理由和结论。';
  document.nodes.push({ id: 'notes', attributes: { name: '备忘录' }, body: '保留这段普通笔记。' });
  const team = teamFromMarkdown(graph.writeMarkdownGraph(document));
  team.nodes[0].prompt = 'Updated task instructions';
  team.nodes[1].depends_on = [];
  const restored = graph.parseMarkdownGraph(teamToMarkdown(team));
  assert.equal(restored.introduction, document.introduction);
  assert.equal(restored.nodes[0].body, 'Updated task instructions');
  assert.deepEqual(graph.nodeDependencies(restored.nodes[1]), []);
  assert.deepEqual(restored.nodes[2], document.nodes[2]);
});

test('adding Team configuration preserves a plain article and requires explicit task sections', () => {
  const source = '# 一份普通文档\n\n## 为什么\n\n只是写作，不要求节点。\n';
  const enabled = enableDocumentTeam(source), document = graph.parseMarkdownGraph(enabled);
  assert.equal(document.introduction, source.trim());
  assert.equal(document.attributes.name, '一份普通文档');
  assert.equal(document.nodes.length, 0);
  assert.throws(() => teamFromMarkdown(enabled), /至少/);
  assert.equal(enableDocumentTeam(enabled), enabled);
});

test('rename and removal update article references and explicit dependencies independently', () => {
  const document = graph.parseMarkdownGraph(teamToMarkdown(workflow));
  document.introduction = '任务见 [[#stock|库存]]。';
  const renamed = graph.renameNode(document, 'stock', 'inventory');
  assert.equal(renamed.introduction, '任务见 [[#inventory|库存]]。');
  assert.deepEqual(graph.nodeDependencies(renamed.nodes[1]), ['inventory']);
  const removed = graph.removeNode(renamed, 'inventory');
  assert.deepEqual(graph.nodeDependencies(removed.nodes[0]), []);
  assert.equal(removed.introduction, '任务见 。');
});

test('legacy Team files remain readable and malformed presentation source remains available for repair', () => {
  const legacy = '---\nid: legacy\nname: Old Team\nmax_parallel: 2\n---\n\nBackground\n\n## first\n```md-node\nagent_id: warehouse\n```\n\nFirst task\n\n## second\n```md-node\nagent_id: reviewer\n```\n\nSecond task\n\n[[#first]]\n';
  const team = teamFromMarkdown(legacy);
  assert.deepEqual(team.nodes[1].depends_on, ['first']);
  assert.equal(team.nodes[1].prompt, 'Second task');
  assert.deepEqual(execution(teamFromMarkdown(teamToMarkdown(team))), execution(team));
  team.presentation.markdown = '---\nname: unfinished';
  assert.equal(teamToMarkdown(team), team.presentation.markdown);
});
test('unfinished code fences and literal md-node examples never hide or drop subsequent workflow nodes', () => {
  for (const prompt of ['任务\n```js\nconst unfinished = true;', '## sample\n```md-node\nname: Example\n```\n正文']) {
    const definition = structuredClone(workflow); definition.description = prompt; definition.nodes[0].prompt = prompt; definition.nodes[1].prompt = prompt;
    const source = teamToMarkdown(definition);
    assert.deepEqual(execution(teamFromMarkdown(source)), definition);
    const document = graph.parseMarkdownGraph(source);
    assert.equal(document.nodes.length, 2);
    assert.deepEqual(graph.nodeDependencies(document.nodes[1]), ['stock']);
    const linked = graph.setNodeLink({ ...document.nodes[0], body: prompt }, 'check', true);
    assert.deepEqual(graph.nodeLinks(linked), ['check']);
    assert.deepEqual(graph.nodeLinks(graph.setNodeLink(linked, 'check', false)), []);
  }
});

test('Markdown file operations preserve cancel, save to selected paths and reject stale external edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-md-test-'));
  try {
    const path = join(directory, 'workflow.md'); let selection;
    const files = new MarkdownFiles(async () => selection);
    assert.equal(await files.command({ action: 'open' }), null);
    assert.equal(await files.command({ action: 'save', text: '# Draft' }), null);
    await assert.rejects(files.command({ action: 'save', path, text: 'x' }), /先选择/);
    selection = path;
    const saved = await files.command({ action: 'save', text: teamToMarkdown(workflow) });
    assert.equal(await readFile(path, 'utf8'), saved.text);
    const opened = await files.command({ action: 'open' });
    assert.equal(opened.revision, saved.revision);
    await writeFile(path, '# External edit');
    await assert.rejects(files.command({ action: 'save', path, revision: opened.revision, text: '# Old edit' }), /外部修改/);
    assert.equal(await readFile(path, 'utf8'), '# External edit');
    const latest = await files.command({ action: 'reload', path });
    await files.command({ action: 'save', path, revision: latest.revision, text: '# Updated' });
    assert.equal(await readFile(path, 'utf8'), '# Updated');
    assert.deepEqual(await readdir(directory), ['workflow.md']);
    selection = join(directory, 'unsafe.txt');
    await assert.rejects(files.command({ action: 'save', text: 'x' }), /Markdown/);
    await assert.rejects(files.command({ action: 'save', text: '文'.repeat(1024 * 1024) }), /2 MB/);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), 'cardbush-md-test-'))); await rm(directory, { recursive: true, force: true }); }
});
test('concurrent file saves serialize and reject the second stale revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-md-test-'));
  try {
    const path = join(directory, 'test.md'); const files = new MarkdownFiles(async () => path);
    const initial = await files.command({ action: 'save', text: 'initial' });
    const result = await Promise.allSettled(['first', 'second'].map(text => files.command({ action: 'save', path, revision: initial.revision, text })));
    assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected');
    assert.equal(await readFile(path, 'utf8'), 'first');
  } finally { assert.ok(directory.startsWith(join(tmpdir(), 'cardbush-md-test-'))); await rm(directory, { recursive: true, force: true }); }
});
test('UTF-8 BOM files save without false conflicts; externally enlarged files remain bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-md-test-'));
  try {
    const path = join(directory, 'bom.md'); await writeFile(path, '\uFEFF# 中文文档');
    const files = new MarkdownFiles(async () => path);
    const opened = await files.command({ action: 'open' });
    assert.equal(opened.text, '# 中文文档');
    await files.command({ action: 'save', path, revision: opened.revision, text: '# 已编辑' });
    const current = await files.command({ action: 'reload', path });
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(files.command({ action: 'save', path, revision: current.revision, text: '# Too late' }), /2 MB/);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), 'cardbush-md-test-'))); await rm(directory, { recursive: true, force: true }); }
});
