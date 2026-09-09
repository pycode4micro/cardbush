import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { PluginHookRunner, expandHookInput } from '../packages/bush-runtime/dist/pluginHookRunner.js';
import { PluginTerminalHooks } from '../packages/bush-runtime/dist/pluginToolHooks.js';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { McpClientManager } from '../packages/bush-mcp-client/dist/index.js';
import { GET_RUNTIME_TOOL_EXECUTION_COMMAND, STOP_RUNTIME_TURN_COMMAND } from '../packages/bush-protocol/dist/index.js';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';
import { loadEnabledProductPluginExtensions, loadProductPluginCatalog } from '../dist-electron/productPlugins.js';

const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'openai-hooks-'));
const request = { protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'session', turnId: 'turn', model: 'fixture', permissionMode: 'task_free', messages: [{ role: 'user', content: 'Test hooks' }], tools: [], metadata: { workspaceDir: root } };
const runners = [], hosts = [], managers = [];
const runner = options => { const value = new PluginHookRunner(root, options); runners.push(value); return value; };
const host = options => { const value = new InMemoryRuntimeHost({ dataRoot: join(root, `host-${hosts.length}`), registerDefaultWorkspaceTools: false, ...options }); hosts.push(value); return value; };
const hook = (event, script, extra = {}) => ({ id: `${event}-${Math.random()}`, pluginId: 'fixture', root, dialect: 'openai', event, matcher: '', type: 'command', command: process.execPath, args: ['-e', script], timeout: 6, ...extra });
const jsonHook = (event, value, extra = {}) => hook(event, `console.log(${JSON.stringify(JSON.stringify(value))})`, extra);
const present = file => access(file).then(() => true, () => false);
const waitFor = async (predicate, label) => { const limit = Date.now() + 7000; while (!await predicate()) { if (Date.now() > limit) throw Error(label); await new Promise(resolve => setTimeout(resolve, 15)); } };
const event = (req, sequence, kind, extra = {}) => ({ protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString(), sequence, kind, ...extra });
const call = (name, input, id = name) => ({ protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(input) });
const identity = { requestId: 'r', sessionId: 'session', turnId: 'turn', round: 1, ordinal: 0 };
const action = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false };
try {
  const engine = runner();
  const gate = (own, other, output) => `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(root, own))},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, other))})){clearInterval(timer);console.log(${JSON.stringify(JSON.stringify(output))})}},10);`;
  const concurrent = await engine.run([
    hook('PreToolUse', gate('a', 'b', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'deny wins' } })),
    hook('PreToolUse', gate('b', 'a', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { value: 2 } } })),
  ], 'PreToolUse', { request, toolName: 'local_tool', input: { value: 1 } });
  assert.match(concurrent.blocked, /deny wins/);
  assert.deepEqual(concurrent.updatedInput, { value: 2 }, 'both matching hooks launch and results merge in declaration order');
  const observations = [];
  const invalid = await engine.run([jsonHook('PreToolUse', { continue: false })], 'PreToolUse', { request }, value => observations.push(value));
  assert.equal(invalid.blocked, undefined);
  assert.match(observations.at(-1).error, /Unsupported PreToolUse/);
  const skippedMarker = join(root, 'untrusted');
  await engine.run([hook('SessionStart', `require('fs').writeFileSync(${JSON.stringify(skippedMarker)},'bad')`, { trusted: false })], 'SessionStart', { request });
  assert.equal(await present(skippedMarker), false);
  const stopped = await engine.run([jsonHook('Stop', { continue: false }, { matcher: '^never$' }), jsonHook('Stop', { decision: 'block', reason: 'continue' })], 'Stop', { request });
  assert.ok(stopped.stopTurn && stopped.continueTurn, 'Stop ignores matchers and explicit stop wins at the host');
  const large = await engine.run([hook('SessionStart', 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"abc".repeat(15000)}}))', { additionalContextLimit: 40 })], 'SessionStart', { request });
  const outputPath = large.messages[0].match(/Full hook output: ([^\n]+)/)[1];
  assert.equal((await readFile(outputPath, 'utf8')).length, 45000);
  assert.ok(large.messages[0].length < 800);
  assert.deepEqual(expandHookInput({ n: '${tool_input.n}', list: ['${tool_input.value}'], text: 'n=${tool_input.n}' }, { tool_input: { n: 3, value: { ok: true } } }), { n: 3, list: [{ ok: true }], text: 'n=3' });
  assert.throws(() => expandHookInput('${__proto__}', {}), /Missing hook input/);

  let executed = 0, approvals = 0;
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'local_tool', description: '', inputSchema: { type: 'object' } }, manifest: action, decodeInput: value => value,
    authorize: ({ input }) => input.hardDeny ? { kind: 'deny', code: 'hard_deny', message: 'host policy' } : { kind: 'ask', request: { reason: 'approve', actions: ['fixture'], targets: [], capabilityIds: ['fixture'] } },
    execute: () => { executed++; return { native: 'original fact' }; } });
  const permissionHooks = [jsonHook('PermissionRequest', { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })];
  const permissionRunner = () => engine.run(permissionHooks, 'PermissionRequest', { request, toolName: 'local_tool', input: {} });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { approvals++; throw Error('Unexpected prompt'); } },
    hooks: { before: async () => ({ messages: [] }), permission: permissionRunner,
      after: () => engine.run([jsonHook('PostToolUse', { decision: 'block', reason: 'review output' })], 'PostToolUse', { request }) } });
  const completed = await coordinator.execute(call('local_tool', {}), identity, undefined, { request: { ...request, tools: registry.definitions() }, contextMessages: [] });
  assert.equal(completed.kind, 'returned'); assert.deepEqual(completed.result, { native: 'original fact' });
  assert.match(completed.hookFeedback, /review output/); assert.equal(completed.rejectToolResult, true); assert.equal(approvals, 0);
  permissionHooks.push(jsonHook('PermissionRequest', { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'deny overrides allow' } } }));
  assert.equal((await coordinator.execute(call('local_tool', {}), identity)).error.code, 'plugin_hook_permission_rejected');
  assert.equal((await coordinator.execute(call('local_tool', { hardDeny: true }), identity)).error.code, 'hard_deny');
  assert.equal(executed, 1);
  const reserved = await engine.run([jsonHook('PermissionRequest', { hookSpecificOutput: { decision: { behavior: 'allow', updatedPermissions: [] } } })], 'PermissionRequest', { request });
  assert.equal(reserved.permissionDecision, 'deny');

  const nestedRegistry = new ToolRegistry();
  nestedRegistry.register({ definition: { name: 'inner', description: '', inputSchema: { type: 'object' } }, manifest: action, decodeInput: value => value, execute: () => ({ actual: 42 }) });
  nestedRegistry.register({ definition: { name: 'outer', description: '', inputSchema: { type: 'object' } }, manifest: action, decodeInput: value => value, execute: async context => ({ fromScript: await context.invokeTool('inner', {}) }) });
  for (const reject of [false, true]) {
    const nestedCoordinator = new ToolExecutionCoordinator({ registry: nestedRegistry, permissions: { request: async () => { throw Error('Unexpected prompt'); } }, hooks: { before: async () => ({ messages: [] }), after: async context => context.toolCall.name === 'inner' ? { messages: ['nested context'], toolFeedback: 'nested feedback', rejectToolResult: reject } : { messages: [] } } });
    const outcome = await nestedCoordinator.execute(call('outer', {}), identity);
    if (reject) { assert.equal(outcome.kind, 'failed'); assert.equal(outcome.error.code, 'plugin_hook_result_blocked'); }
    else { assert.equal(outcome.kind, 'returned'); assert.deepEqual(outcome.result, { fromScript: { actual: 42 } }); assert.equal(outcome.hookFeedback, 'nested feedback'); assert.deepEqual(outcome.hookMessages, ['nested context']); }
  }
  const invalidRewrite = runner({ validateToolInput: () => { throw Error('tool schema rejected the replacement'); } }), invalidEvents = [];
  assert.deepEqual(await invalidRewrite.run([jsonHook('PreToolUse', { hookSpecificOutput: { permissionDecision: 'allow', updatedInput: {} } })], 'PreToolUse', { request, toolName: 'target', input: { required: true } }, value => invalidEvents.push(value)), { messages: [] });
  assert.ok(invalidEvents.some(value => value.error?.includes('tool schema')));

  const terminals = new PluginTerminalHooks(), terminalEvents = [];
  const terminalHooks = terminals.forTurn('session', async (event, context) => { terminalEvents.push({ event, context }); return { messages: [] }; });
  const originalCall = call('terminal_exec', { command: 'long task' }, 'original');
  await terminalHooks.before({ toolCall: originalCall, input: { command: 'long task' } });
  await terminalHooks.after({ toolCall: originalCall, input: { command: 'long task' }, outcome: { kind: 'returned', result: { terminalSessionId: 'terminal1', state: 'running' } } });
  const poll = call('terminal_poll', { session_id: 'terminal1' }, 'poll');
  await terminalHooks.before({ toolCall: poll, input: { session_id: 'terminal1' } });
  await terminalHooks.after({ toolCall: poll, input: { session_id: 'terminal1' }, outcome: { kind: 'returned', result: { terminalSessionId: 'terminal1', state: 'exited', exitCode: 1 } } });
  assert.deepEqual(terminalEvents.map(value => value.event), ['PreToolUse', 'PostToolUse']);
  assert.equal(terminalEvents[1].context.toolCallId, 'original');
  assert.equal(terminalEvents[1].context.input.command, 'long task');

  const release = join(root, 'release-background'), background = runner(), backgroundEvents = [];
  const job = index => hook('PostToolUse', `const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log(JSON.stringify({decision:'block',reason:'must not block',hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'background ${index}'}}))}},10);`, { async: true });
  assert.deepEqual(await background.run(Array.from({ length: 9 }, (_, index) => job(index)), 'PostToolUse', { request }, value => backgroundEvents.push(value)), { messages: [] });
  assert.equal(backgroundEvents.filter(value => value.phase === 'running').length, 8, 'per-session background concurrency is bounded at eight');
  assert.equal(backgroundEvents.filter(value => value.phase === 'queued').length, 9);
  await writeFile(release, 'release');
  await waitFor(() => backgroundEvents.filter(value => value.phase === 'completed').length === 9, 'all background invocations complete');
  await new Promise(resolve => setTimeout(resolve, 0));
  const deliveries = background.takeMessages('session');
  assert.equal(deliveries.length, 9); assert.ok(deliveries.every(value => value.messages[0].includes('background')));
  assert.deepEqual(background.takeMessages('session'), [], 'background output is consumed once');
  const closeEvents = [];
  await background.run([hook('PostToolUse', 'setInterval(()=>{},1000)', { async: true }), jsonHook('SessionEnd', { systemMessage: 'closed' }, { timeout: 1, async: true })], 'PostToolUse', { request }, value => closeEvents.push(value));
  await background.closeSession('session');
  assert.ok(closeEvents.some(value => value.phase === 'cancelled'));
  assert.ok(closeEvents.some(value => value.hook.event === 'SessionEnd' && value.phase === 'completed'));
  assert.deepEqual(background.takeMessages('session'), []);

  // Real MCP transport: hooks reuse its connection, preserving template types and bypassing hook recursion.
  const serverFile = join(root, 'mcp-fixture.mjs');
  await writeFile(serverFile, `import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'; import { serveStdio } from '@modelcontextprotocol/server/stdio';
await serveStdio(()=>{const s=new McpServer({name:'hook-fixture',version:'1'});s.registerTool('policy',{inputSchema:fromJsonSchema({type:'object',properties:{n:{type:'number'},items:{type:'array',items:{type:'number'}}},required:['n','items']}),description:'policy'},async input=>({content:[{type:'text',text:JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{n:input.n,valid:Array.isArray(input.items)&&typeof input.n==='number'}}})}]}));return s;});`);
  const mcpRegistry = new ToolRegistry(), manager = new McpClientManager({ registry: mcpRegistry }); managers.push(manager);
  await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'hook-fixture', revision: 1, servers: [{ id: 'checker', transport: { kind: 'stdio', command: process.execPath, args: [serverFile], cwd: root }, defaultToolPolicy: { permission: 'ask', parallelSafe: false, visibleToChild: true }, toolPolicies: {} }] });
  const mcpHook = { ...hook('PreToolUse', ''), type: 'mcp_tool', server: 'checker', tool: 'policy', matcher: '^target$', input: { n: '${tool_input.n}', items: '${tool_input.items}' } };
  const mcpRequests = []; let targetInput;
  mcpRegistry.register({ definition: { name: 'target', description: '', inputSchema: { type: 'object' } }, manifest: action, decodeInput: value => value, execute: ({ input }) => { targetInput = input; return { raw: 'fact' }; } });
  const mcpHost = host({ toolRegistry: mcpRegistry, loadPluginExtensions: async () => ({ hooks: [mcpHook, jsonHook('PostToolUse', { decision: 'block', reason: 'sanitized model feedback' }, { matcher: '^target$' })], agents: [] }), provider: { async *stream(req) {
    mcpRequests.push(structuredClone(req)); yield event(req, 0, 'response_started');
    if (mcpRequests.length === 1) { yield event(req, 1, 'tool_call_delta', { index: 0, toolCallId: 'target-call', nameDelta: 'target', argumentsDelta: JSON.stringify({ n: 7, items: [1, 2] }) }); yield event(req, 2, 'response_completed', { finishReason: 'tool_calls' }); }
    else { yield event(req, 1, 'text_delta', { delta: 'finished' }); yield event(req, 2, 'response_completed', { finishReason: 'stop' }); }
  } } });
  await mcpHost.runModelTurn({ ...request, sessionId: 'mcp', turnId: 'mcp-turn', tools: mcpRegistry.definitions() });
  assert.deepEqual(targetInput, { n: 7, valid: true });
  assert.ok(mcpRequests[1].messages.some(value => value.role === 'tool' && value.content.includes('sanitized model feedback')));
  const stored = await mcpHost.sendCommand({ kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND, payload: { sessionId: 'mcp', turnId: 'mcp-turn', toolCallId: 'target-call' } });
  assert.deepEqual(stored.result, { raw: 'fact' });
  assert.deepEqual(JSON.parse(stored.toolCall.argumentsText), targetInput, 'execution facts retain the rewritten arguments');
  assert.equal(manager.snapshot().servers[0].restartAttempts, 0);
  const unavailable = runner({ callMcp: async () => { throw Error('not connected'); } });
  assert.deepEqual(await unavailable.run([mcpHook], 'PreToolUse', { request, toolName: 'target', input: { n: 1, items: [] } }), { messages: [] });

  const pluginRoot = join(root, 'plugins', 'trusted'); await mkdir(pluginRoot, { recursive: true });
  const manifestPath = join(pluginRoot, 'plugin.json'), configPath = join(root, 'apps.json');
  const manifest = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'trusted', extensions: { 'com.openai': { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'console.log("trusted")'] }] }], Stop: [{ hooks: [{ type: 'prompt', prompt: 'ignored' }] }] } } } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const roots = [{ path: join(root, 'plugins'), source: 'user' }];
  assert.ok((await loadEnabledProductPluginExtensions(roots, configPath)).hooks.every(value => value.trusted === false));
  const catalog = await loadProductPluginCatalog(roots), hash = catalog[0].components.find(value => value.name === 'SessionStart').hook.definitionHash;
  await writeFile(configPath, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'trusted', installed: true, enabled: true, config: { trustedHookHashes: [hash] } }] }));
  assert.equal((await loadEnabledProductPluginExtensions(roots, configPath)).hooks[0].trusted, true);
  manifest.extensions['com.openai'].hooks.SessionStart[0].hooks[0].args = ['-e', 'console.log("changed")'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await loadEnabledProductPluginExtensions(roots, configPath)).hooks[0].trusted, false, 'changed definitions lose trust');
  const resolved = await resolvePluginManifest(pluginRoot);
  assert.ok(resolved.notes.some(value => value.includes('parsed but skipped')));

  // Completed background work is delivered on the next user turn without waking a model itself.
  const backgroundDone = join(root, 'host-background-done'), backgroundRequests = [];
  const backgroundHost = host({ loadPluginExtensions: async () => ({ agents: [], hooks: [hook('UserPromptSubmit', `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(backgroundDone)},'done');console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'deferred context'}}))},150)`, { async: true, once: true })] }), provider: { async *stream(req) { backgroundRequests.push(structuredClone(req)); yield event(req, 0, 'response_started'); yield event(req, 1, 'text_delta', { delta: 'done' }); yield event(req, 2, 'response_completed', { finishReason: 'stop' }); } } });
  await backgroundHost.runModelTurn({ ...request, sessionId: 'background', turnId: 'bg1' });
  const closedEvents = backgroundHost.events('background', 'bg1');
  const backgroundCall = closedEvents.find(value => value.kind === 'tool_queued').payload.toolCallId;
  await waitFor(async () => await present(backgroundDone) && Boolean(await backgroundHost.sendCommand({ kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND, payload: { sessionId: 'background', turnId: 'bg1', toolCallId: backgroundCall } })), 'background result recorded after terminal');
  assert.deepEqual(backgroundHost.events('background', 'bg1'), closedEvents, 'late completion preserves the terminal event boundary');
  assert.equal(backgroundRequests.length, 1);
  await backgroundHost.runModelTurn({ ...request, sessionId: 'background', turnId: 'bg2' });
  assert.ok(backgroundRequests[1].messages.some(value => value.role === 'developer' && value.content.includes('deferred context')));

  const interrupted = join(root, 'interrupt'), ended = join(root, 'session-end');
  let streamStarted = false;
  const stoppingHost = host({ loadPluginExtensions: async () => ({ agents: [], hooks: [hook('Interrupt', `require('fs').writeFileSync(${JSON.stringify(interrupted)},'yes')`, { timeout: 1 }), hook('SessionEnd', `require('fs').writeFileSync(${JSON.stringify(ended)},'yes')`, { timeout: 1 })] }), provider: { async *stream(req, options) { streamStarted = true; yield event(req, 0, 'response_started'); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } } });
  const stopping = stoppingHost.runModelTurn({ ...request, sessionId: 'interrupt-session', turnId: 'interrupt-turn' });
  await waitFor(() => streamStarted, 'active model before interrupt');
  await stoppingHost.sendCommand({ kind: STOP_RUNTIME_TURN_COMMAND, payload: { sessionId: 'interrupt-session', turnId: 'interrupt-turn' } });
  await stopping;
  assert.equal(await present(interrupted), true);
  await stoppingHost.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  assert.equal(await present(ended), true);

  // Compaction events surround the actual checkpoint; stopping either side has
  // distinct effects and SessionStart(compact) runs before immediate continuation.
  for (const stopAt of [undefined, 'PreCompact', 'PostCompact']) {
    const compactRegistry = new ToolRegistry(), compactEvents = [], compactRequests = [];
    compactRegistry.register({ definition: { name: 'compaction_policy', description: '', inputSchema: { type: 'object' } }, manifest: action, decodeInput: value => value, execute: () => ({}),
      mcpHook: { server: 'lifecycle', tool: 'observe', call: async input => {
        compactEvents.push(input.event);
        return { structuredContent: input.event === stopAt ? { continue: false, stopReason: 'fixture stop' }
          : input.event === 'SessionStart' ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'context after compaction' } } : {} };
      } } });
    const compactHost = host({ toolRegistry: compactRegistry, loadPluginExtensions: async () => ({ agents: [], hooks: ['PreCompact', 'PostCompact', 'SessionStart'].map(event => ({ ...hook(event, ''), type: 'mcp_tool', server: 'lifecycle', tool: 'observe', matcher: event === 'SessionStart' ? '^compact$' : '^auto$', input: { event: '${hook_event_name}' } })) }), provider: {
      async countInputTokens(req) { return { inputTokens: req.messages.some(value => value.name === 'turn_context_summary') ? 100 : req.messages.some(value => value.name === 'context_pressure') ? 2900 : 2860, source: 'provider' }; },
      async *stream(req) {
        compactRequests.push(structuredClone(req)); yield event(req, 0, 'response_started');
        if (compactRequests.length > 1 && req.messages.some(value => value.name === 'context_pressure')) {
          yield event(req, 1, 'tool_call_delta', { index: 0, toolCallId: 'checkpoint', nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify({ summaries: ['The previous user message was answered.'], active_summary: '' }) });
          yield event(req, 2, 'response_completed', { finishReason: 'tool_calls' });
        } else { yield event(req, 1, 'text_delta', { delta: 'done' }); yield event(req, 2, 'response_completed', { finishReason: 'stop' }); }
      }
    } });
    const sessionTurn = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId: 'compact', turnId, model: 'fixture', prefixMessages: [{ role: 'system', content: 'fixed-prefix' }], inputMessages: [{ messageId: `user-${turnId}`, createdAt: new Date().toISOString(), message: { role: 'user', content: 'continue' } }], tools: [], metadata: {} });
    await compactHost.runSessionTurn(sessionTurn('first'));
    await compactHost.runSessionTurn({ ...sessionTurn('second'), maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000 } });
    assert.deepEqual(compactEvents, stopAt === 'PreCompact' ? ['PreCompact'] : stopAt === 'PostCompact' ? ['PreCompact', 'PostCompact'] : ['PreCompact', 'PostCompact', 'SessionStart']);
    const facts = compactHost.events('compact', 'second');
    assert.equal(facts.at(-1).payload.status, stopAt ? 'stopped' : 'completed');
    assert.equal(facts.some(value => value.kind === 'context_compaction_completed'), stopAt !== 'PreCompact');
    assert.equal(compactRequests.length, stopAt === 'PreCompact' ? 1 : stopAt === 'PostCompact' ? 2 : 3);
    if (!stopAt) assert.ok(compactRequests.at(-1).messages.some(value => value.role === 'developer' && value.content.includes('context after compaction')));
  }
  console.log('OpenAI hooks passed: concurrent merge, trust hashes, output contracts, real MCP transport, permission mediation, terminal completion, bounded background delivery/cancellation, spilling, Interrupt and SessionEnd.');
} finally {
  for (const value of hosts) await value.sendCommand({ kind: 'runtime.shutdown', payload: {} }).catch(() => undefined);
  await Promise.allSettled(runners.map(value => value.close()));
  await Promise.allSettled(managers.map(value => value.close()));
  assert.ok(resolve(root).startsWith(parent + sep));
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
