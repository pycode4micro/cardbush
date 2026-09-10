import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';
import { installProductPlugin, loadEnabledProductPluginExtensions } from '../dist-electron/productPlugins.js';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator, registerSkillTools, registerPluginCommandTools, readPluginSkill } from '../packages/bush-runtime/dist/index.js';
import { PluginHookRunner, modelHookDecision } from '../packages/bush-runtime/dist/pluginHookRunner.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-plugin-compat-'));
const plugin = join(root, 'source', 'compat'), installed = join(root, 'installed'), config = join(root, 'apps.json');
const write = async (path, text) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
const hosts = [];
const request = (registry, id, text, metadata = {}) => ({ protocol: 'bush.model_request.v1', requestId: `r-${id}`, sessionId: `s-${id}`, turnId: `t-${id}`, model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), messages: [{ role: 'user', content: text }], metadata: { workspaceDir: root, ...metadata } });
async function* answer(req, text) {
  const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' }; yield { ...base, sequence: 1, kind: 'text_delta', delta: text }; yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
}
try {
  await write(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'compat', lspServers: { ignored: { command: 'must-not-start' } } }));
  await write(join(plugin, 'skills/manual/SKILL.md'), '---\nname: manual\ndescription: >\n  A manual review workflow\n---\nCheck $ARGUMENTS at ${CLAUDE_SKILL_DIR}.');
  await write(join(plugin, 'skills/manual/agents/openai.yaml'), 'interface:\n  short_description: Manual review\npolicy:\n  allow_implicit_invocation: false\n');
  await write(join(plugin, 'skills/forked/SKILL.md'), '---\nname: forked\ndescription: isolated review\ncontext: fork\nbackground: false\nagent: reviewer\n---\nReview $ARGUMENTS');
  await write(join(plugin, 'skills/reference/SKILL.md'), '---\nname: reference\ndescription: shared reference\n---\nAlways inspect the actual evidence.');
  await write(join(plugin, 'agents/reviewer.md'), '---\nname: reviewer\ntools: Read\nskills: [reference]\nmaxTurns: 3\n---\nReview carefully.');
  const preview = await resolvePluginManifest(plugin);
  assert.deepEqual(preview.issues, []); assert.ok(preview.notes.some(note => note.includes('LSP')));
  assert.match(preview.extensions.agents[0].skills[0].prompt, /actual evidence/);
  await installProductPlugin(plugin, installed);
  const loader = () => loadEnabledProductPluginExtensions([{ path: installed, source: 'user' }], config);
  const registry = new ToolRegistry(); registerSkillTools(registry, [join(installed, 'compat/skills')]);
  const observed = [];
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, dataRoot: join(root, 'runtime'), loadPluginExtensions: loader,
    provider: { async *stream(req) { observed.push(req); yield* answer(req, req.metadata.agentRole === 'child' ? 'Reviewed in isolation.' : 'Done.'); } } }); hosts.push(host);
  const search = registry.resolve('search_skills');
  assert.ok(!(await search.execute({ input: { query: 'review', limit: 10 } })).matches.some(skill => skill.name.endsWith(':manual')));
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected approval'); } } });
  const req = request(registry, 'deny', 'review');
  const denied = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'auto', name: 'run_skill', argumentsText: JSON.stringify({ command: 'compat:manual' }) }, { requestId: req.requestId, sessionId: req.sessionId, turnId: req.turnId, ordinal: 0, round: 1 }, undefined, { request: req, contextMessages: [] });
  assert.equal(denied.error.code, 'plugin_command_invocation_disabled');
  assert.equal((await host.runModelTurn(request(registry, 'manual', '$compat:manual "some files"'))).payload.status, 'completed');
  assert.ok(observed.at(-1).messages.some(message => message.role === 'tool' && /Check "some files"/.test(message.content)));
  assert.equal((await host.runModelTurn(request(registry, 'fork', '/compat:forked changes'))).payload.status, 'completed');
  const child = observed.find(req => req.metadata.agentRole === 'child');
  assert.deepEqual(child.tools.map(tool => tool.name).filter(name => name !== 'checkpoint_context'), ['read_file']);
  assert.ok(child.messages.some(message => /actual evidence/.test(message.content)));
  assert.ok(!child.messages.some(message => message.content === '/compat:forked changes'));
  assert.ok(observed.at(-1).messages.some(message => message.role === 'tool' && /Reviewed in isolation/.test(message.content)));
  // Standard OpenAI packages resolve declared MCP dependencies without running anything at inspection time.
  const portable = join(root, 'portable');
  await write(join(portable, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'portable' }));
  await write(join(portable, 'skills/docs/SKILL.md'), '---\nname: docs\ndescription: Documentation\n---\nUse docs.');
  await write(join(portable, 'skills/docs/agents/openai.yaml'), 'dependencies:\n  tools:\n    - type: mcp\n      value: documentation\n      transport: streamable_http\n      url: https://example.com/mcp\n');
  const declared = await resolvePluginManifest(portable);
  assert.deepEqual(declared.issues, []); assert.equal(declared.manifest.mcpServers.documentation.url, 'https://example.com/mcp');
  assert.deepEqual(declared.extensions.skills[0].dependencyServers, ['plugin_portable_documentation']);
  const dependencyRegistry = new ToolRegistry();
  registerPluginCommandTools(dependencyRegistry, async () => declared.extensions.skills, { skill: true });
  const dependencyCoordinator = new ToolExecutionCoordinator({ registry: dependencyRegistry, permissions: { request: async () => { throw Error('Unexpected approval'); } } });
  const dependencyRequest = request(dependencyRegistry, 'dependency', 'Read documentation');
  const invokeDependency = () => dependencyCoordinator.execute({ protocol: 'bush.tool_call.v1', id: 'dependency', name: 'run_skill', argumentsText: '{"command":"portable:docs"}' }, { requestId: dependencyRequest.requestId, sessionId: dependencyRequest.sessionId, turnId: dependencyRequest.turnId, ordinal: 0, round: 1 }, undefined, { request: dependencyRequest, contextMessages: [] });
  assert.equal((await invokeDependency()).error.code, 'plugin_skill_dependency_unavailable');
  dependencyRegistry.register({ definition: { name: 'docs_lookup', description: '', inputSchema: { type: 'object' } }, manifest: { effect_kind: 'observation', operation: 'fixture.lookup', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false }, decodeInput: x => x, execute: () => ({}), mcpHook: { server: 'plugin_portable_documentation', tool: 'lookup', call: async () => ({}) } });
  assert.equal((await invokeDependency()).error.code, 'plugin_skill_dependency_unavailable', 'registered but unexposed dependency is unavailable');
  dependencyRequest.tools = dependencyRegistry.definitions();
  assert.equal((await invokeDependency()).kind, 'returned');
  dependencyRequest.metadata.disabledSkills = ['portable:docs'];
  assert.equal((await invokeDependency()).error.code, 'plugin_skill_disabled');
  await write(join(portable, 'skills/docs/agents/openai.yaml'), 'policy: [false]\n');
  await assert.rejects(readPluginSkill(join(portable, 'skills/docs/SKILL.md')), /policy must be a mapping/);
  // Real runtime model hooks: block a tool, keep the evaluation isolated, and never recursively run hooks.
  const hookRegistry = new ToolRegistry(); let writes = 0, evaluations = 0;
  hookRegistry.register({ definition: { name: 'write_file', description: '', inputSchema: { type: 'object' } }, manifest: { effect_kind: 'filesystem_change', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: true }, executionChannel: 'fixture:write', parallelSafe: false, decodeInput: x => x, execute: () => { writes++; return 'written'; } });
  const hook = { id: 'check', pluginId: 'compat', root: plugin, event: 'PreToolUse', matcher: '', type: 'prompt', dialect: 'claude', command: '', prompt: 'Check $ARGUMENTS', timeout: 5, once: false, trusted: true };
  const hookHost = new InMemoryRuntimeHost({ toolRegistry: hookRegistry, dataRoot: join(root, 'hook-runtime'), registerDefaultWorkspaceTools: false, loadPluginExtensions: async () => ({ hooks: [hook], agents: [] }),
    provider: { async *stream(req) {
      if (req.metadata.pluginHookEvaluation) { evaluations++; assert.deepEqual(req.tools, []); yield* answer(req, '{"ok":false,"reason":"not ready"}'); return; }
      const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'write', nameDelta: 'write_file', argumentsDelta: '{}' };
      yield { ...base, sequence: 2, kind: 'tool_call_delta', index: 1, toolCallId: 'write-queued', nameDelta: 'write_file', argumentsDelta: '{}' };
      yield { ...base, sequence: 3, kind: 'response_completed', finishReason: 'tool_calls' };
    } } }); hosts.push(hookHost);
  const stopped = await hookHost.runModelTurn(request(hookRegistry, 'hook', 'Write'));
  assert.equal(stopped.payload.status, 'stopped', JSON.stringify(stopped)); assert.equal(writes, 0); assert.equal(evaluations, 1);
  // Agent hooks can inspect evidence over multiple model rounds without inheriting write tools or recursive Hooks.
  const evidenceRegistry = new ToolRegistry(); let reads = 0, agentEvaluations = 0;
  evidenceRegistry.register({ definition: { name: 'read_file', description: 'Read evidence', inputSchema: { type: 'object' } }, manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false }, decodeInput: x => x, execute: () => { reads++; return { content: 'Verified evidence' }; } });
  const evidenceHost = new InMemoryRuntimeHost({ toolRegistry: evidenceRegistry, dataRoot: join(root, 'evidence-runtime'), registerDefaultWorkspaceTools: false, loadPluginExtensions: async () => ({ hooks: [{ ...hook, type: 'agent', event: 'Stop' }], agents: [] }), provider: { async *stream(req) {
    if (!req.metadata.pluginHookEvaluation) { yield* answer(req, 'Done.'); return; }
    agentEvaluations++; assert.deepEqual(req.tools.map(tool => tool.name), ['read_file']);
    if (req.messages.some(message => message.role === 'tool')) { yield* answer(req, '{"ok":true}'); return; }
    const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' };
    yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'evidence', nameDelta: 'read_file', argumentsDelta: '{}' };
    yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
  } } }); hosts.push(evidenceHost);
  assert.equal((await evidenceHost.runModelTurn(request(evidenceRegistry, 'evidence', 'Review'))).payload.status, 'completed');
  assert.equal(reads, 1); assert.equal(agentEvaluations, 2);
  assert.ok(modelHookDecision({ ...hook, event: 'Stop' }, { ok: false, reason: 'continue' }).continueTurn);
  assert.deepEqual(modelHookDecision({ ...hook, event: 'Stop' }, { ok: false, reason: 'impossible', impossible: true }), { messages: [] });
  assert.throws(() => modelHookDecision(hook, { ok: 'false' }), /must return/);
  let calls = 0; const runner = new PluginHookRunner(join(root, 'hook-direct'), { evaluate: async () => { calls++; return { ok: true }; } });
  await runner.run([{ ...hook, dialect: 'openai' }], 'PreToolUse', { request: req }); assert.equal(calls, 0, 'OpenAI dialect retains skipped model hooks');
  await runner.run([{ ...hook, trusted: false }], 'PreToolUse', { request: req }); assert.equal(calls, 0);
  // A non-cooperating evaluator cannot leave a task waiting forever or apply a late denial.
  let finishLate; const observations = [];
  const hanging = new PluginHookRunner(join(root, 'hanging-runtime'), { evaluate: () => new Promise(resolve => { finishLate = resolve; }) });
  let guard;
  try {
    const bounded = await Promise.race([hanging.run([{ ...hook, timeout: 0.01 }], 'PreToolUse', { request: req }, event => observations.push(event)), new Promise((_, reject) => { guard = setTimeout(() => reject(Error('Hook timeout did not settle')), 2000); })]);
    assert.deepEqual(bounded, { messages: [] }); assert.match(observations.at(-1).error, /timed out/);
    finishLate({ ok: false, reason: 'Too late' }); await Promise.resolve();
    assert.equal(observations.filter(event => event.phase === 'completed').length, 1);
    const controller = new AbortController();
    const pending = hanging.run([hook], 'PreToolUse', { request: req, signal: controller.signal });
    controller.abort(new Error('User cancelled')); await assert.rejects(pending, /User cancelled/);
  } finally { clearTimeout(guard); await hanging.close(); }
  // HTTP hooks send bounded JSON and consume normal hook output; no redirects are followed.
  let received;
  const server = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk; received = JSON.parse(body); response.setHeader('Content-Type', 'application/json'); response.end('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"HTTP check"}}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const result = await runner.run([{ ...hook, type: 'http', url: `http://127.0.0.1:${server.address().port}` }], 'PreToolUse', { request: req }); assert.match(result.blocked, /HTTP check/); assert.equal(received.hook_event_name, 'PreToolUse'); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await runner.close();
  assert.equal(await readFile(join(installed, 'compat/skills/reference/SKILL.md'), 'utf8'), await readFile(join(plugin, 'skills/reference/SKILL.md'), 'utf8'));
  // Unsupported Skill behavior cannot pass local installation or be introduced after installation.
  await write(join(plugin, 'skills/reference/SKILL.md'), '---\nname: reference\nhooks: invalid\n---\nInvalid local hooks.');
  assert.ok((await resolvePluginManifest(plugin)).issues.some(issue => /skills.reference: hooks/.test(issue.detail)));
  await assert.rejects(installProductPlugin(plugin, join(root, 'invalid-install')), /skills.reference: hooks/);
  await write(join(installed, 'compat/skills/reference/SKILL.md'), '---\nname: reference\nhooks: invalid\n---\nInvalid local hooks.');
  await assert.rejects(loader(), /skills.reference: hooks/);
  await write(join(plugin, 'skills/reference/SKILL.md'), '---\nname: manual\n---\nSame invocation name.');
  assert.ok((await resolvePluginManifest(plugin)).issues.some(issue => /duplicate invocation names/.test(issue.detail)));
  console.log('Plugin compatibility passed: LSP exclusion, OpenAI policy/dependencies, namespaced Skills, explicit invocation, isolated execution, Agent Skill preload, native model/HTTP Hooks, decision control and trust.');
} finally {
  for (const host of hosts) await host.close?.();
  assert.ok(root.startsWith(parent + sep + 'cardbush-plugin-compat-'));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
