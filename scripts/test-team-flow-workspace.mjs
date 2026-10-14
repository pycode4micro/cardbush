import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
const require = createRequire(import.meta.url);
function load(path) {
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports, id => id === '@cardbush/bush-protocol' ? protocol : require(id));
  return exports;
}
const { teamGraphDocument, teamNodeTitle } = load('src/features/team/teamFlowGraph.ts');
const { layoutNodes, graphLinks, nodePosition } = load('src/features/mdPresentation/markdownGraph.ts');
const { teamConversationRequest } = load('src/features/team/teamConversationContext.ts');

test('the shared canvas respects workflow dependencies and centers parallel levels', () => {
  const workflow = { nodes: [
    { id: 'report', depends_on: ['facts', 'prices'], position: { x: -900, y: 700 }, prompt: 'Refer to [[#extra]]', agent_id: 'editor' },
    { id: 'facts', depends_on: ['input'] }, { id: 'input', depends_on: [] }, { id: 'prices', depends_on: ['input'] },
  ], presentation: { markdown: '[[#another]]' } };
  const document = teamGraphDocument(workflow, [{ id: 'editor', name: '编辑' }]);
  const horizontal = layoutNodes(document.nodes, true);
  assert.ok(horizontal.get('input').x < horizontal.get('facts').x);
  assert.equal(horizontal.get('facts').x, horizontal.get('prices').x);
  assert.notEqual(horizontal.get('facts').y, horizontal.get('prices').y);
  assert.ok(horizontal.get('report').x > horizontal.get('prices').x);
  assert.equal(horizontal.get('report').y, (horizontal.get('facts').y + horizontal.get('prices').y) / 2);
  assert.deepEqual(layoutNodes(document.nodes, true), horizontal, 'refreshes cannot reshuffle stable diagrams');
  assert.deepEqual(graphLinks(document.nodes[0]), ['facts', 'prices'], 'prompt and Markdown links never become execution dependencies');
  assert.deepEqual(nodePosition(document.nodes[0]), { x: -900, y: 700 }, 'saved positions survive the adapter for manual arrangement');
  assert.equal(document.nodes[0].attributes.name, '编辑', 'prefer human labels to raw task IDs');
  document.nodes[0].attributes.position.x = 20;
  document.nodes[0].attributes.depends_on.push('extra');
  assert.equal(workflow.nodes[0].position.x, -900, 'editing the canvas cannot mutate canonical data or run snapshots');
  assert.deepEqual(workflow.nodes[0].depends_on, ['facts', 'prices']);
  assert.equal(teamNodeTitle({ id: 'raw', agent_id: 'missing' }, []), 'raw');
});

test('queued workflow requests preserve both original user context and the submission target', () => {
  const input = { text: '修改这一步', context: [{ kind: 'preview-selection', content: 'a selected document' }] };
  const target = { teamId: 'one', revision: 3, nodeId: 'report', runId: 'run-one' };
  const request = teamConversationRequest(input, target);
  target.teamId = 'two'; target.revision = 4;
  assert.equal(request.text, input.text);
  assert.equal(input.context.length, 1);
  assert.deepEqual(request.context[0], input.context[0]);
  assert.deepEqual(JSON.parse(request.context[1].content.split('(data): ')[1]), { teamId: 'one', revision: 3, nodeId: 'report', runId: 'run-one' });
});
