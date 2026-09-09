import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';
import { installProductPlugin, loadEnabledProductPluginExtensions, loadProductPluginCatalog, loadEnabledProductPluginSkillRoots } from '../dist-electron/productPlugins.js';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator, commandArguments } from '../packages/bush-runtime/dist/index.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-native-command-'));
const source = join(root, 'source/native-demo'), installed = join(root, 'installed'), workspace = join(root, 'workspace');
const roots = [{ path: installed, source: 'user' }], configPath = join(root, 'apps.json');
try {
  await mkdir(join(source, '.claude-plugin'), { recursive: true });
  await mkdir(join(source, 'commands')); await mkdir(workspace);
  await writeFile(join(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'native-demo', version: '1.0.0' }));
  const original = '---\ndescription: Native review command\nargument-hint: "[file] [mode]"\narguments: [file, mode]\ndisable-model-invocation: true\ndisallowed-tools: Write\nallowed-tools: "Read, Bash(git status:*)"\n---\nReview $file in $mode mode; indexed=$ARGUMENTS[0]; zero=$0; rest=$ARGUMENTS\nDynamic: !`printf \'%s\' "$ARGUMENTS"`\nRoot: ${CLAUDE_PLUGIN_ROOT}\n';
  await writeFile(join(source, 'commands/review.md'), original);
  await writeFile(join(source, 'commands/model-only.md'), '---\nuser-invocable: false\n---\nModel-only $ARGUMENTS');
  await writeFile(join(source, 'commands/denied.md'), '---\n---\n!`printf sensitive-action`');
  await writeFile(join(source, 'commands/slow.md'), '---\n---\n!`sleep 10`');
  await writeFile(join(source, 'commands/restricted.md'), '---\ndisallowed-tools: Write\n---\nInspect without writing.');
  const adapted = await resolvePluginManifest(source);
  assert.deepEqual(adapted.issues, []);
  assert.equal(adapted.manifest.commands, './commands');
  assert.equal(adapted.manifest.skills, undefined);
  assert.equal(await readFile(join(source, 'commands/review.md'), 'utf8'), original, 'command source is not rewritten');
  assert.ok(!(await readdir(source)).some(name => name.includes('imported')), 'no generated command/skill folders');
  await installProductPlugin(source, installed);
  const catalog = await loadProductPluginCatalog(roots);
  assert.equal(catalog[0].components.filter(item => item.kind === 'command').length, 5);
  assert.deepEqual(await loadEnabledProductPluginSkillRoots(roots, configPath), []);
  const loader = () => loadEnabledProductPluginExtensions(roots, configPath);
  assert.deepEqual(commandArguments('"one two" C:\\temp\\test.txt \'three four\''), ['one two', 'C:\\temp\\test.txt', 'three four']);
  assert.throws(() => commandArguments('"unclosed'), /引号/);
  const registry = new ToolRegistry(); let admissions = 0, writes = 0;
  const manifest = { effect_kind: 'filesystem_change', operation: 'fixture.operation', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: true };
  registry.register({ definition: { name: 'terminal_exec', description: 'fixture admission', inputSchema: { type: 'object' } }, manifest, decodeInput: value => value,
    authorize: context => { admissions++; assert.equal(context.input.shell, 'posix'); return context.input.command.includes('sensitive-action') ? { kind: 'deny', code: 'fixture-denied', message: 'hard denial' } : { kind: 'allow' }; },
    execute: () => { throw Error('Command context uses its bounded subprocess runner'); } });
  registry.register({ definition: { name: 'write_file', description: '', inputSchema: { type: 'object' } }, manifest, executionChannel: 'fixture:files', decodeInput: value => value, execute: () => { writes++; return 'written'; } });
  const requests = [];
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false, dataRoot: join(root, 'runtime'), loadPluginExtensions: loader,
    provider: { async *stream(request) {
      requests.push(request);
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      if (request.turnId === 'barrier-t' && !request.messages.some(message => message.role === 'tool' && message.toolCallId === 'barrier-command')) {
        yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'barrier-command', nameDelta: 'run_plugin_command', argumentsDelta: JSON.stringify({ command: 'native-demo:restricted' }) };
        yield { ...base, sequence: 2, kind: 'tool_call_delta', index: 1, toolCallId: 'barrier-write', nameDelta: 'write_file', argumentsDelta: '{}' };
        yield { ...base, sequence: 3, kind: 'response_completed', finishReason: 'tool_calls' };
        return;
      }
      yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Command ready.' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), metadata: { workspaceDir: workspace }, messages: [{ role: 'user', content: '/native-demo:review "one two" three' }] };
  const terminal = await host.runModelTurn(request);
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  const toolMessage = requests[0].messages.find(message => message.role === 'tool' && message.toolCallId.startsWith('plugin_command_'));
  assert.ok(toolMessage, JSON.stringify(requests[0].messages));
  assert.match(toolMessage.content, /Review one two in three mode; indexed=one two; zero=one two/);
  assert.match(toolMessage.content, /Dynamic: "one two" three/);
  assert.ok(toolMessage.content.includes(join(installed, 'native-demo')));
  assert.equal(admissions, 1);
  assert.equal(host.events('s', 't').filter(event => event.kind === 'tool_returned' && event.payload.toolName === 'run_plugin_command').length, 1);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected ask'); } } });
  const identity = { requestId: 'r2', sessionId: 's2', turnId: 't2', round: 1, ordinal: 0 };
  const call = (command, args = '') => ({ protocol: 'bush.tool_call.v1', id: 'model-call', name: 'run_plugin_command', argumentsText: JSON.stringify({ command, arguments: args }) });
  assert.equal((await coordinator.execute(call('native-demo:review'), identity, undefined, { request, contextMessages: [] })).error.code, 'plugin_command_invocation_disabled');
  const modelOnly = await coordinator.execute(call('native-demo:model-only', 'test'), identity, undefined, { request, contextMessages: [] });
  assert.equal(modelOnly.kind, 'returned'); assert.match(modelOnly.result.instructions, /Model-only test/);
  assert.equal((await coordinator.execute(call('native-demo:denied'), identity, undefined, { request, contextMessages: [] })).error.code, 'fixture-denied');
  const activeRequest = { ...request, metadata: requests[0].metadata };
  const write = { protocol: 'bush.tool_call.v1', id: 'write', name: 'write_file', argumentsText: '{}' };
  assert.equal((await coordinator.execute(write, identity, undefined, { request: activeRequest, contextMessages: [] })).error.code, 'plugin_command_tool_disallowed');
  assert.equal(writes, 0);
  assert.equal((await coordinator.execute(write, identity, undefined, { request, contextMessages: [] })).kind, 'returned', 'restrictions do not leak into a fresh turn');
  const priorWrites = writes;
  await host.runModelTurn({ ...request, requestId: 'barrier-r', sessionId: 'barrier-s', turnId: 'barrier-t', messages: [{ role: 'user', content: 'Apply the restricted command then inspect.' }] });
  assert.equal(writes, priorWrites, 'command restrictions apply before a sibling in a different execution channel');
  assert.ok(host.events('barrier-s', 'barrier-t').some(event => event.kind === 'tool_failed' && event.payload.error.code === 'plugin_command_tool_disallowed'));
  // Parameters remain shell data, even when they contain shell substitution syntax.
  const literal = '"$(touch injected.txt); literal"';
  await host.runModelTurn({ ...request, requestId: 'safe-r', sessionId: 'safe-s', turnId: 'safe-t', messages: [{ role: 'user', content: `/native-demo:review ${literal}` }] });
  assert.ok(!(await readdir(workspace)).includes('injected.txt'));
  assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('$(touch injected.txt); literal')));
  // Stopping a command settles its operation and cancels the bounded process.
  const abort = new AbortController();
  const pending = host.runModelTurn({ ...request, requestId: 'stop-r', sessionId: 'stop-s', turnId: 'stop-t', messages: [{ role: 'user', content: '/native-demo:slow' }] }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 150);
  assert.equal((await pending).payload.status, 'stopped');
  assert.ok(host.events('stop-s', 'stop-t').some(event => event.kind === 'tool_cancelled'));
  await writeFile(configPath, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'native-demo', installed: true, enabled: false }] }));
  assert.deepEqual((await loader()).commands, []);
  assert.equal((await coordinator.execute(call('native-demo:model-only'), identity, undefined, { request, contextMessages: [] })).error.code, 'plugin_command_unavailable');
  console.log('Native Commands passed: untouched source, distinct catalog, slash dispatch, parameters, real dynamic context, permission denial, model/user invocation rules, turn restrictions, injection resistance, cancellation and disable.');
} finally {
  assert.ok(root.startsWith(parent + sep + 'cardbush-native-command-'));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
