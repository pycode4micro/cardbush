import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { importPluginManifest } from '../dist-electron/pluginManifestImport.js';
import { installProductPlugin, loadProductPluginCatalog, loadEnabledProductPluginExtensions } from '../dist-electron/productPlugins.js';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator, SubagentTaskStore, registerSubagentTool } from '../packages/bush-runtime/dist/index.js';
import { PluginHookRunner } from '../packages/bush-runtime/dist/pluginHookRunner.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-plugin-extensions-'));
const source = join(root, 'source', 'extensions-demo'), installed = join(root, 'plugins'), workspace = join(root, 'workspace');
const configPath = join(root, 'apps.json');
const manifest = { name: 'extensions-demo', version: '1.0.0' };
const present = file => access(file).then(() => true, () => false);
const registry = new ToolRegistry();
const action = { effect_kind: 'filesystem_change', operation: 'filesystem.write', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: true };
let writes = 0, authorizedPath = '';
registry.register({ definition: { name: 'write_file', description: '', inputSchema: { type: 'object' } }, manifest: action,
  decodeInput: value => value, authorize: ({ input }) => { authorizedPath = input.path; return input.path === 'denied.txt' ? { kind: 'deny', code: 'denied_fixture', message: 'denied' } : { kind: 'allow' }; },
  execute: async ({ input }) => { writes++; await writeFile(join(workspace, input.path), input.content); return { written: input.path }; } });
registry.register({ definition: { name: 'read_file', description: '', inputSchema: { type: 'object' } }, manifest: { ...action, mutating: false, effect_kind: 'observation' }, decodeInput: value => value, execute: () => 'read fixture' });
try {
  await mkdir(join(source, '.claude-plugin'), { recursive: true });
  await mkdir(join(source, 'hooks')); await mkdir(join(source, 'agents')); await mkdir(join(source, 'commands')); await mkdir(workspace);
  await writeFile(join(source, '.claude-plugin/plugin.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'agents/reviewer.md'), '---\nname: reviewer\ndescription: >\n  Review files carefully.\ntools: [Read, Write]\ndisallowedTools: Write\nmodel: sonnet\nmaxTurns: 3\n---\nInspect the evidence before replying.');
  await writeFile(join(source, 'commands/review.md'), '---\ndescription: Review the current change\n---\nReview $ARGUMENTS with the available file tools.');
  const script = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const value=JSON.parse(input);require('fs').appendFileSync(require('path').join(value.cwd,'hook-events.jsonl'),JSON.stringify(value)+'\\n');
if(value.hook_event_name==='PreToolUse'){if(value.tool_input.path==='blocked.txt'){process.stderr.write('blocked fixture');process.exitCode=2;return;}console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{file_path:value.tool_input.path==='deny-original.txt'?'denied.txt':'approved.txt',content:'edited by hook'}}}));}
else if(value.hook_event_name==='Stop'&&!value.stop_hook_active)console.log(JSON.stringify({decision:'block',reason:'Verify the completed result before finishing.'}));
else if(value.hook_event_name==='SessionStart'||value.hook_event_name==='UserPromptSubmit'||value.hook_event_name==='PostToolUse')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:value.hook_event_name,additionalContext:'fixture hook context '+value.hook_event_name}}));});`;
  await writeFile(join(source, 'hooks/run.cjs'), script);
  const hookMap = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(event => [event, [{ matcher: event.includes('Tool') ? 'Write' : '', hooks: [{ type: 'command', command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.cjs'], timeout: 5 }] }]]));
  await writeFile(join(source, 'hooks/hooks.json'), JSON.stringify({ hooks: hookMap }));
  const adapted = await importPluginManifest(source, manifest);
  assert.equal(adapted.issues.length, 0, JSON.stringify(adapted.issues));
  assert.ok(adapted.notes.some(note => note.includes('model inherits')));
  assert.equal(await present(join(workspace, 'hook-events.jsonl')), false, 'inspection never executes hooks');
  await installProductPlugin(source, installed);
  const roots = [{ path: installed, source: 'user' }];
  const catalog = await loadProductPluginCatalog(roots);
  assert.equal(catalog[0].components.filter(value => value.kind === 'agent').length, 1);
  assert.equal(catalog[0].components.filter(value => value.kind === 'hook').length, 5);
  assert.equal(catalog[0].components.filter(value => value.kind === 'command').length, 1, 'commands keep their native component type');
  assert.equal(catalog[0].components.filter(value => value.kind === 'skill').length, 0, 'commands do not generate Skills');
  const extensions = await loadEnabledProductPluginExtensions(roots, configPath);
  assert.equal(extensions.agents[0].description, 'Review files carefully.\n');
  assert.equal(extensions.agents[0].root, join(installed, manifest.name));
  const loader = () => loadEnabledProductPluginExtensions(roots, configPath);
  let rounds = 0; const requests = [];
  const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolRegistry: registry, registerDefaultWorkspaceTools: false, loadPluginExtensions: loader,
    provider: { async *stream(request) {
      requests.push(request); rounds++;
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      if (rounds === 1) {
        yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'write-one', nameDelta: 'write_file', argumentsDelta: JSON.stringify({ path: 'original.txt', content: 'original' }) };
        yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
      } else {
        yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Verified complete.' };
        yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
      }
    } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free',
    messages: [{ role: 'user', content: 'Perform one write.' }], tools: registry.definitions(), metadata: { workspaceDir: workspace } };
  const terminal = await host.runModelTurn(request);
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(writes, 1, 'Stop feedback does not replay a completed action');
  assert.equal(rounds, 3, 'Stop hook causes exactly one continuation');
  assert.equal(authorizedPath, 'approved.txt', 'updated inputs are authorized before execution');
  assert.equal(await readFile(join(workspace, 'approved.txt'), 'utf8'), 'edited by hook');
  assert.ok(requests[0].messages.some(message => message.content.includes('fixture hook context SessionStart')));
  assert.ok(requests[1].messages.some(message => message.content.includes('fixture hook context PostToolUse')));
  const logs = (await readFile(join(workspace, 'hook-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(logs.map(value => value.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Stop']);
  assert.equal(logs.at(-1).stop_hook_active, true);

  const runner = new PluginHookRunner(join(root, 'runtime'));
  const before = context => runner.run(extensions.hooks, 'PreToolUse', { request, toolName: context.toolCall.name, input: context.input });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission'); } }, hooks: { before, after: async () => ({ messages: [] }) } });
  const identity = { requestId: 'r2', sessionId: 's2', turnId: 't2', round: 1, ordinal: 0 };
  const call = path => ({ protocol: 'bush.tool_call.v1', id: path, name: 'write_file', argumentsText: JSON.stringify({ path, content: 'test' }) });
  const denied = await coordinator.execute(call('deny-original.txt'), identity, undefined, { request, contextMessages: [] });
  assert.equal(denied.kind, 'failed'); assert.equal(denied.error.code, 'denied_fixture', 'hook allow never bypasses host permission');
  const blocked = await coordinator.execute(call('blocked.txt'), identity, undefined, { request, contextMessages: [] });
  assert.equal(blocked.kind, 'failed'); assert.equal(blocked.error.code, 'plugin_hook_blocked');
  assert.equal(writes, 1);
  const postFailure = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission'); } },
    hooks: { before: async () => ({ messages: [] }), after: async () => { throw Error('post hook failed'); } } });
  const completed = await postFailure.execute(call('completed.txt'), identity, undefined, { request, contextMessages: [] });
  assert.equal(completed.kind, 'returned'); assert.equal(completed.result.written, 'completed.txt');
  assert.match(completed.hookMessages[0], /completed result remains valid/);

  let child;
  const agentRegistry = new ToolRegistry();
  for (const name of ['read_file', 'write_file']) agentRegistry.register(registry.resolve(name));
  registerSubagentTool(agentRegistry, new SubagentTaskStore(), async request => {
    child = request;
    return { terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'final' } }, session: { turns: [{ turnId: request.turnId, messages: [{ messageId: 'final', message: { role: 'assistant', content: 'reviewed' } }], usage: {} }] } };
  }, { loadPluginAgents: async () => (await loader()).agents });
  const agentCoordinator = new ToolExecutionCoordinator({ registry: agentRegistry, permissions: { request: async () => { throw Error('Unexpected permission'); } } });
  const delegated = await agentCoordinator.execute({ protocol: 'bush.tool_call.v1', id: 'agent', name: 'subagent', argumentsText: JSON.stringify({ prompt: 'Review', agent_type: 'extensions-demo:reviewer' }) }, identity, undefined,
    { request: { ...request, tools: agentRegistry.definitions() }, contextMessages: [] });
  assert.equal(delegated.kind, 'returned', JSON.stringify(delegated));
  assert.deepEqual(child.tools.map(tool => tool.name), ['read_file']);
  assert.equal(child.model, request.model);
  assert.equal(child.metadata.pluginAgentMaxTurns, 3);
  assert.ok(child.prefixMessages.some(message => message.content.includes('Inspect the evidence')));

  await writeFile(configPath, JSON.stringify({ serviceEnabled: true, plugins: [{ id: manifest.name, installed: true, enabled: false }] }));
  assert.deepEqual(await loader(), { agents: [], hooks: [], commands: [] }, 'disabling a plugin removes all capabilities');
  const unavailable = await agentCoordinator.execute({ protocol: 'bush.tool_call.v1', id: 'disabled-agent', name: 'subagent', argumentsText: JSON.stringify({ prompt: 'Review', agent_type: 'extensions-demo:reviewer' }) }, identity, undefined,
    { request: { ...request, tools: agentRegistry.definitions() }, contextMessages: [] });
  assert.equal(unavailable.kind, 'failed');

  const slowHook = { ...extensions.hooks[0], event: 'PreToolUse', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeout: .12 };
  const timed = await runner.run([slowHook], 'PreToolUse', { request });
  assert.match(timed.blocked, /timed out/);
  const controller = new AbortController();
  const observations = [];
  const pending = runner.run([{ ...slowHook, timeout: 10 }], 'PreToolUse', { request, signal: controller.signal }, entry => observations.push(entry));
  setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 100);
  await assert.rejects(pending, /Stopped|cancelled/);
  assert.deepEqual(observations.map(entry => entry.phase), ['running', 'cancelled'], 'stopped hook settles its visible status');
  const asks = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw new DOMException('Stopped', 'AbortError'); } },
    hooks: { before: async () => ({ messages: [], ask: 'Confirm fixture' }), after: async () => ({ messages: [] }) } });
  assert.equal((await asks.execute(call('never-written.txt'), identity, undefined, { request, contextMessages: [] })).kind, 'cancelled');
  assert.equal(await present(join(workspace, 'never-written.txt')), false);

  const hostStop = new AbortController();
  const stoppingHost = new InMemoryRuntimeHost({ dataRoot: join(root, 'stopping-runtime'), registerDefaultWorkspaceTools: false,
    loadPluginExtensions: async () => ({ agents: [], hooks: [{ ...slowHook, event: 'SessionStart', matcher: '', timeout: 10 }] }),
    provider: { async *stream() { throw Error('Provider must not run after a stopped startup hook'); } } });
  const stopping = stoppingHost.runModelTurn({ ...request, sessionId: 'stopping-session', turnId: 'stopping-turn', tools: [] }, { signal: hostStop.signal });
  const stopDeadline = Date.now() + 3000;
  while (!stoppingHost.events('stopping-session', 'stopping-turn').some(event => event.kind === 'tool_running') && Date.now() < stopDeadline) await new Promise(fulfill => setTimeout(fulfill, 10));
  hostStop.abort();
  await stopping;
  const stoppedEvents = stoppingHost.events('stopping-session', 'stopping-turn');
  const startedHook = stoppedEvents.find(event => event.kind === 'tool_running');
  assert.ok(startedHook, 'startup hook actually began');
  assert.ok(stoppedEvents.some(event => event.kind === 'tool_cancelled' && event.payload.toolCallId === startedHook.payload.toolCallId), 'host closes cancelled hook status');

  await writeFile(join(source, 'hooks/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Unsupported native hook' }] }] } }));
  await assert.rejects(installProductPlugin(source, installed), /unsupported runtime components/, 'local installation validates executable features too');
  console.log('Plugin extensions passed: import, discovery, Commands, real hook processes, lifecycle feedback, input reauthorization, denial, post-failure receipts, Agent restrictions, disable, timeout and stop.');
} finally {
  assert.ok(root.startsWith(parent + sep + 'cardbush-plugin-extensions-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
