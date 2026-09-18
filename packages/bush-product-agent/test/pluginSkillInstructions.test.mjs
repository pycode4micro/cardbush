import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest, ROOT_AGENT_SYSTEM_PROMPT, CHILD_AGENT_SYSTEM_PROMPT } from '../dist/index.js';

test('plugin Skill rules stay in a stable system prefix while real hook feedback remains append-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-rules-'));
  const registry = new ToolRegistry(), observed = [], feedback = [];
  let skillName = 'first';
  const skill = () => ({ id: `fixture:${skillName}`, kind: 'skill', pluginId: 'fixture', root,
    path: join(root, 'SKILL.md'), name: skillName, description: 'Fixture Skill', prompt: 'Fixture instructions.',
    arguments: [], argumentHint: '', userInvocable: true, disableModelInvocation: false, shell: 'powershell' });
  registry.register({ definition: { name: 'hook_context', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'test', dispatch_scope: 'process', mutating: false },
    decodeInput: value => value, execute: () => ({}),
    mcpHook: { server: 'fixture', tool: 'context', call: async input => {
      const content = `Actual ${input.event} feedback ${feedback.length + 1}`;
      feedback.push(`fixture / ${input.event}: ${content}`);
      return { structuredContent: { hookSpecificOutput: { hookEventName: input.event, additionalContext: content } } };
    } },
  });
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    loadPluginExtensions: async () => ({ agents: [], skills: [skill()], hooks: ['SessionStart', 'UserPromptSubmit'].map(event => ({
      id: `fixture:${event}`, pluginId: 'fixture', root, event, matcher: '', trusted: true,
      type: 'mcp_tool', server: 'fixture', tool: 'context', command: '', timeout: 5, input: { event: '${hook_event_name}' },
    })) }),
    provider: { async *stream(request) {
      observed.push(structuredClone(request));
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-18T08:00:00Z' };
      yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Done.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
    } },
  });
  t.after(async () => {
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-plugin-rules-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const id of ['first', 'second', 'changed']) {
    if (id === 'changed') skillName = 'replacement';
    const request = createProductAgentTurnRequest({ requestId: id, sessionId: 'plugin-rules', turnId: id, messageId: `user_${id}`,
      createdAt: '2026-09-18T08:00:00Z',
      userText: 'Continue.', model: 'fixture',
      tools: registry.definitions().filter(tool => ['run_skill', 'search_skills'].includes(tool.name)),
      permissionMode: 'task_free', planEnabled: false });
    assert.equal((await host.runSessionTurn(request)).payload.status, 'completed');
    const current = observed.at(-1);
    assert.ok(current.tools.some(tool => tool.name === 'run_skill'));
    assert.equal(current.messages[0].content, ROOT_AGENT_SYSTEM_PROMPT);
    assert.match(current.messages[0].content, /To invoke an installed plugin Skill, use run_skill/);
    const hooks = current.messages.filter(message => message.name === 'plugin_hook_feedback');
    assert.deepEqual(hooks.map(message => message.content), feedback);
    assert.ok(hooks.every(message => message.role === 'developer'));
    if (observed.length > 1) assert.deepEqual(current.messages.slice(0, observed.at(-2).messages.length), observed.at(-2).messages);
  }
  assert.equal(CHILD_AGENT_SYSTEM_PROMPT, ROOT_AGENT_SYSTEM_PROMPT);
  assert.equal(feedback.length, 4, 'SessionStart runs once; each actual prompt hook still runs');
  const session = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'plugin-rules' } });
  assert.deepEqual(session.turns.map(turn => turn.messages.filter(item => item.message.name === 'plugin_hook_feedback').length), [2, 1, 1]);
});
