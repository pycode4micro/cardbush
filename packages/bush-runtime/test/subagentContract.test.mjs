import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { ToolRegistry, SubagentTaskStore, registerSubagentTool } from '../dist/index.js';
import { decodeSubagentInput } from '../dist/subagentTool.js';
import { withToolDisplayTitle, stripToolDisplayTitle } from '../dist/toolDisplay.js';

const title = { zh: '跟进审核', en: 'Continue review' };
function schemas() {
  const registry = new ToolRegistry();
  registerSubagentTool(registry, new SubagentTaskStore(), async () => { throw Error('No execution permitted'); }, {
    agents: {}, guideChild: async () => {}, runBackground: async () => {}, remoteAgents: {}, loadPluginAgents: async () => [],
  });
  const registration = registry.resolve('subagent'), full = registration.definition;
  const compact = registration.projectModelDefinition(full, { canRecall: true });
  return { full, compact };
}
test('portable full and projected declarations explain the recorded follow-up error and decoder rejects it before dispatch', () => {
  const { full, compact } = schemas();
  const ajv = new Ajv({ strict: false });
  for (const definition of [full, compact]) {
    assert.match(definition.inputSchema.properties.task_id.description, /Follow-up accepts only:.*prompt, task_id, run_in_background/);
    assert.match(definition.inputSchema.properties.name.description, /Omit when task_id or agent_id/);
    for (const keyword of ['allOf', 'anyOf', 'oneOf', 'if', 'then']) assert.equal(keyword in definition.inputSchema, false);
    const validate = ajv.compile(withToolDisplayTitle(definition).inputSchema);
    const input = { task_id: 'child-task', prompt: '请收尾', run_in_background: true, _display_title: title };
    assert.equal(validate(input), true, JSON.stringify(validate.errors));
    for (const extra of [{ name: '安全与权限审核' }, { mode: 'fork' }, { agent_id: 'employee' }, { target_agent: 'remote' }, { agent_type: 'plugin:role' }]) {
      assert.throws(() => decodeSubagentInput(stripToolDisplayTitle({ ...input, ...extra }, definition)));
    }
    assert.throws(() => decodeSubagentInput({ ...stripToolDisplayTitle(input, definition), name: '安全与权限审核' }), /Remove name.*has not started or guided/);
    assert.equal(decodeSubagentInput(stripToolDisplayTitle(input, definition)).taskId, 'child-task');
  }
});
test('documented variants validate and invalid cross-field combinations fail before execution', () => {
  const { full } = schemas(), validate = new Ajv({ strict: false }).compile(withToolDisplayTitle(full).inputSchema);
  const cases = [
    [{ prompt: 'read', name: '审核' }, true], [{ prompt: 'read', mode: 'fork' }, true],
    [{ prompt: 'read', mode: 'clean', system_prompt: 'Independent review' }, true],
    [{ prompt: 'read', agent_id: 'employee', mode: 'clean' }, true],
    [{ prompt: 'read', target_agent: 'remote', name: '远程审核' }, true],
    [{ action: 'save', agent: { id: 'reviewer', name: 'Reviewer', system_prompt: 'Review' }, expected_revision: 0 }, true],
    [{ action: 'delete', agent_id: 'reviewer', expected_revision: 1 }, true],
    [{}, false], [{ prompt: '   ' }, false], [{ prompt: 'read', name: 'a\nb' }, false],
    [{ prompt: 'read', mode: 'clean' }, false], [{ prompt: 'read', settings: {} }, false],
    [{ prompt: 'read', system_prompt: 'wrong mode' }, false], [{ prompt: 'read', inherit_context: true }, false],
    [{ prompt: 'read', agent_id: 'employee', name: 'override' }, false],
    [{ prompt: 'read', target_agent: 'remote', run_in_background: true }, false],
    [{ action: 'save', expected_revision: 0 }, false], [{ action: 'delete', agent_id: 'reviewer' }, false],
  ];
  for (const [input, expected] of cases) {
    if (expected) {
      assert.equal(validate({ ...input, _display_title: title }), true, JSON.stringify({ input, errors: validate.errors }));
      assert.doesNotThrow(() => decodeSubagentInput(input));
    }
    else assert.throws(() => decodeSubagentInput(input), JSON.stringify(input));
  }
});
