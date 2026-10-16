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

test('graph receipts update locally and an older background list cannot roll them back', async () => {
  const first = { revision: 1, updatedAt: '2026-10-16T01:00:00Z', definition: { id: 'flow', name: 'Workflow', description: '', nodes: [{ id: 'step', position: { x: 10, y: 20 } }] } };
  let teams = [first], delayed, listCalls = 0;
  const calls = [], exports = {};
  const hooks = { useEffect() {}, useSyncExternalStore(subscribe, read) { subscribe(() => calls.push(read())); return read(); } };
  new Function('exports', 'require', ts.transpileModule(readFileSync('src/features/team/teamWorkspaceStore.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports, id => {
    if (id === 'react') return hooks;
    if (id === '@cardbush/bush-protocol') return protocol;
    if (id.includes('promptReferences')) return { teamReferenceInstructions: id => id };
    if (id.includes('ElectronRuntimeSession')) return { createDesktopRuntimeSession: () => ({ dispose() {}, client: { command: async ({ kind }) => {
      if (kind === protocol.AGENT_REGISTRY_COMMAND) return [];
      listCalls++;
      const result = structuredClone({ teams, runs: [] }), wait = delayed; delayed = undefined;
      if (wait) await wait.promise;
      return result;
    } } }) };
    throw Error('Unexpected import ' + id);
  });
  await exports.refreshTeamWorkspace();
  const before = exports.useTeamWorkspace(false), choices = exports.useTeamChoices(false).choices;
  await exports.refreshTeamWorkspace(false, true);
  assert.equal(exports.useTeamWorkspace(false).teams, before.teams, 'unchanged definitions retain identity');
  assert.equal(exports.useTeamWorkspace(false).runs, before.runs, 'unchanged runs retain identity');
  const gate = Promise.withResolvers(); delayed = gate;
  const refresh = exports.refreshTeamWorkspace(false, true), reads = listCalls;
  const second = { ...first, revision: 2, updatedAt: '2026-10-16T01:00:01Z', definition: { ...first.definition, nodes: [{ id: 'step', position: { x: 30, y: 60 } }] } };
  teams = [second]; calls.length = 0;
  exports.acceptTeamWorkflow(second);
  assert.equal(listCalls, reads, 'accepting a save does not re-fetch the library');
  assert.equal(exports.useTeamChoices(false).choices, choices, 'layout changes do not alter composer choices');
  assert.equal(exports.currentTeamWorkflow('flow'), second);
  gate.resolve(); await refresh;
  assert.ok(calls.filter(state => state.teams).every(state => state.teams[0].revision === 2), 'an in-flight old list never replaces the saved definition');
  assert.equal(exports.currentTeamWorkflow('flow'), second);
  exports.acceptTeamWorkflow(first);
  assert.equal(exports.currentTeamWorkflow('flow'), second, 'late save replies cannot roll back a newer revision');
  teams = []; await exports.refreshTeamWorkspace(false, true);
  exports.acceptTeamWorkflow(second);
  assert.equal(exports.currentTeamWorkflow('flow'), undefined, 'late receipts cannot resurrect deleted workflows');
});
