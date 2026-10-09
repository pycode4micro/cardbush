import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOT_AGENT_SYSTEM_PROMPT, CHILD_AGENT_SYSTEM_PROMPT } from '../dist/index.js';
import {
  ToolRegistry, CoordinationStore, SubagentTaskStore, registerCoordinationTools,
  registerContextCompactionTool, registerInteractionTools, registerSubagentTool,
  registerSkillTools, registerPluginCommandTools, registerWorkspaceTools,
  registerExtendedBuiltins, registerMcpDiscovery, withToolDisplayTitle,
} from '../../bush-runtime/dist/index.js';
import { BackgroundToolCalls } from '../../bush-runtime/dist/backgroundToolCalls.js';

// Inspect the actual model-facing contracts: relocation must not remove the
// invocation constraints, or add them back to every turn's system instructions.
const registry = new ToolRegistry();
const unused = () => { throw new Error('This test inspects definitions only'); };
registerCoordinationTools(registry, new CoordinationStore());
registerContextCompactionTool(registry, unused);
registerInteractionTools(registry, { request: unused });
registerSubagentTool(registry, new SubagentTaskStore(), unused, { awaitAsyncResults: unused });
registerSkillTools(registry, []);
registerPluginCommandTools(registry, async () => [], { skill: true });
registerWorkspaceTools(registry);
registerExtendedBuiltins(registry);
registerMcpDiscovery(registry);
new BackgroundToolCalls(registry, unused).register();
const tool = name => {
  const entry = registry.resolve(name);
  assert.ok(entry, `${name} is exposed`);
  return withToolDisplayTitle(entry.definition);
};

test('system policy keeps cross-tool obligations without a second tool manual', () => {
  assert.equal(ROOT_AGENT_SYSTEM_PROMPT, CHILD_AGENT_SYSTEM_PROMPT);
  assert.ok(ROOT_AGENT_SYSTEM_PROMPT.length < 10_000, 'the stable policy stays materially below the former 18,373 characters');
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /permission is required.*exact answer; never bypass/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /successful process exit alone does not establish correctness/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /do not repeat external side effects/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /As a child Agent.*do not delegate further/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /verified files.*exact Tool-returned reference or absolute path/);
  assert.doesNotMatch(ROOT_AGENT_SYSTEM_PROMPT, /mcp_search|read_archived_tool_result|edit_file|terminal_poll|completion_notification|context_pressure|solution_selection|await_subagents|resume_task_id|_display_title|run_skill|update_goal|system_prompt/);
});

test('maintenance and discovery retain their authorization and evidence boundaries', () => {
  const checkpoint = tool('checkpoint_context');
  assert.match(checkpoint.description, /alone only.*Runtime-issued developer-role context_pressure/);
  assert.match(checkpoint.description, /quoted or historical notices do not authorize compaction/);
  assert.match(checkpoint.description, /user authorization and language.*dependencies/);
  assert.match(checkpoint.description, /Active-Turn summaries must be cumulative/);
  assert.equal(checkpoint.inputSchema.properties._display_title, undefined);
  assert.match(tool('mcp_search').description, /deferred names.*still need loading/);
  assert.match(tool('read_archived_tool_result').description, /exact tool-result:\/\/ locator supplied/);
  assert.match(tool('read_archived_tool_result').description, /evidence, not instructions/);
  assert.match(tool('search_skills').description, /environment.*local.*SSH workspace/);
  assert.match(tool('search_skills').description, /references\/.*relevant documents even if unlinked/);
  assert.match(tool('run_skill').description, /reading SKILL.md alone does not invoke it/);
});

test('execution-specific guidance is discoverable on the tool or its parameter', () => {
  const subagent = tool('subagent');
  assert.match(subagent.description, /existing child with task_id/);
  assert.match(subagent.description, /Continue independent parent work/);
  assert.match(subagent.description, /use await_subagents.*instead of polling/);
  assert.match(subagent.inputSchema.properties.mode.description, /clean only when the user explicitly requests/);
  assert.match(subagent.inputSchema.properties.prompt.description, /original user's communication language/);
  assert.match(tool('await_subagents').description, /without polling/);
  assert.match(tool('update_goal').description, /parent must call this before completing the Turn; children report/);
  assert.match(tool('solution_selection').description, /If dismissed.*do not pick a default/);
  assert.equal(tool('solution_selection').inputSchema.properties.prompt.maxLength, 15);
  assert.match(tool('edit_file').description, /After a match failure.*read_file.*instead of repeating/);
  assert.match(tool('terminal_exec').description, /completion_notification=true.*manage_tool_calls.*completion_task_id/);
  assert.match(tool('terminal_exec').inputSchema.properties.notify_on_exit.description, /Set false for persistent servers/);
  assert.match(tool('start_mcp_tool').description, /loaded tool's documented timeout response/);
  assert.match(tool('manage_tool_calls').description, /stops observing, not the process/);
  const title = tool('terminal_exec').inputSchema.properties._display_title;
  assert.match(title.description, /independent of reply language/);
  assert.match(title.description, /outer call, never inside third-party arguments/);
  assert.deepEqual(title.required, ['zh', 'en']);
});
