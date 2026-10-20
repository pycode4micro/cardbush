import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { usageDefinitionSchema } from '@cardbush/bush-protocol';
import { exportUsagePackage } from '../packages/bush-runtime/dist/usagePackage.js';
import { InMemoryRuntimeHost, CoordinationStore, ToolRegistry } from '../packages/bush-runtime/dist/index.js';
import { PluginHookRunner } from '../packages/bush-runtime/dist/pluginHookRunner.js';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';
import { installProductPlugin, loadEnabledProductPluginExtensions } from '../dist-electron/productPlugins.js';

const definition = () => usageDefinitionSchema.parse({ protocol: 'bush.usage.v1', id: 'package-fixture', name: 'Document method',
  objective: 'Make and inspect a document.', entry_node: 'make', plan: ['make', 'inspect'],
  nodes: [{ id: 'make', name: 'Make', instruction: 'Make the requested content.' }, { id: 'inspect', name: 'Inspect', instruction: 'Inspect the actual result.' }] });
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-usage-plugin-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  return root;
}
async function setup(t, hooks) {
  const root = await temporary(t), source = join(root, 'source'), installed = join(root, 'installed'), config = join(root, 'apps.json');
  const bundle = exportUsagePackage(definition());
  for (const file of bundle.files) { const path = join(source, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.content); }
  if (hooks) {
    const path = join(source, 'commands/use.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('usage: ./usage.json\n', `usage: ./usage.json\nhooks: ${JSON.stringify(hooks)}\n`));
  }
  assert.deepEqual((await resolvePluginManifest(source)).issues, []);
  await installProductPlugin(source, installed);
  const load = () => loadEnabledProductPluginExtensions([{ path: installed, source: 'user' }], config);
  const trust = async (enabled = true) => {
    const hooks = (await resolvePluginManifest(join(installed, bundle.plugin_id))).extensions.hooks;
    await writeFile(config, JSON.stringify({ serviceEnabled: true, plugins: [{ id: bundle.plugin_id, installed: true, enabled,
      config: { trustedHookHashes: hooks.map(hook => hook.definitionHash) } }] }));
  };
  const plan = new CoordinationStore();
  function runtime(countInputTokens) {
    const registry = new ToolRegistry(), requests = [], actions = new Map(), effects = [];
    registry.register({ definition: { name: 'fixture_effect', description: 'Fixture mutation', inputSchema: { type: 'object' } },
      manifest: { effect_kind: 'filesystem_change', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: true },
      decodeInput: value => value, execute: context => { effects.push(context.input); return { ok: true }; } });
    const counts = new Map();
    const host = new InMemoryRuntimeHost({ toolRegistry: registry, coordinationStore: plan, dataRoot: join(root, 'runtime'), registerDefaultWorkspaceTools: false,
      loadPluginExtensions: load, provider: { ...(countInputTokens ? { countInputTokens } : {}), async *stream(request) {
        requests.push(structuredClone(request));
        const count = counts.get(request.turnId) ?? 0; counts.set(request.turnId, count + 1);
        const action = actions.get(request.turnId)?.[count];
        const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
        yield { ...base, sequence: 0, kind: 'response_started' };
        if (action) {
          const call = typeof action === 'function' ? action(request) : action;
          yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `${request.turnId}-${count}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
          yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
        } else {
          yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Fixture complete.' };
          yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
        }
      } } });
    const run = async (turnId, message, calls = [], sessionId = 'session') => {
      actions.set(turnId, calls);
      const result = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: `r-${turnId}`, sessionId, turnId, model: 'fixture', permissionMode: 'task_free',
        tools: registry.definitions(), metadata: { workspaceDir: root }, messages: [{ role: 'user', content: message }] });
      assert.equal(result.payload.status, 'completed', JSON.stringify(result));
      return requests.filter(request => request.turnId === turnId);
    };
    const runSession = async (turnId, message, calls = [], extra = {}) => {
      actions.set(turnId, calls);
      const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: `r-${turnId}`, sessionId: 'session', turnId, model: 'fixture', permissionMode: 'task_free',
        prefixMessages: [{ role: 'system', content: 'Follow the current user task.' }], tools: registry.definitions(), ...extra, metadata: { workspaceDir: root, ...extra.metadata },
        inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: message } }] });
      assert.equal(result.payload.status, 'completed', JSON.stringify({ result, maintenance: host.events('session', turnId)
        .filter(event => event.kind.includes('compaction') || event.kind === 'tool_failed').map(event => ({ kind: event.kind, payload: event.payload })) }));
      return requests.filter(request => request.turnId === turnId);
    };
    return { host, effects, run, runSession };
  }
  return { root, bundle, source, installed, load, trust, plan, runtime };
}
const guidance = request => {
  const message = request.messages.findLast(message => message.name === 'usage_guidance');
  return message ? JSON.parse(message.content) : undefined;
};
const call = (name, input) => ({ name, input });
const effect = allow => call('fixture_effect', { allow });

test('exported package installs normally, is user-selected, follows native plan and restores after restart', async t => {
  const f = await setup(t), r = f.runtime();
  assert.ok((await f.load()).commands.every(command => command.disableModelInvocation));
  const idle = await r.run('idle', 'Ordinary task'); assert.equal(guidance(idle[0]), undefined);
  const auto = await r.run('auto', 'Ordinary task', [call('run_plugin_command', { command: `${f.bundle.plugin_id}:use` })]);
  assert.ok(auto.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('usage_user_selection_required')));
  assert.equal(guidance(auto.at(-1)), undefined);
  const selected = await r.run('selected', `${f.bundle.activation} topic`, [request => {
    const view = guidance(request); assert.equal(view.plan.phase, 'unbound');
    return call('update_task_plan', { ...view.plan.plan_template.input,
      nodes: view.plan.plan_template.input.nodes.map((node, index) => ({ ...node, status: index ? 'in_progress' : 'completed' })) });
  }]);
  assert.equal(guidance(selected.at(-1)).plan.current_node, 'inspect');
  const revision = f.plan.getPlan('session').revision;
  const restarted = f.runtime();
  assert.equal(guidance((await restarted.run('restored', 'Continue with a compacted conversation'))[0]).plan.current_node, 'inspect');
  assert.equal(f.plan.getPlan('session').revision, revision);
  const replaced = await restarted.run('replace-attempt', 'Continue', [call('usage', { action: 'import', expected_revision: 1, usage: definition() })]);
  assert.ok(replaced.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('usage_user_selection_required')));
  await restarted.run('stop', f.bundle.deactivation);
  assert.equal(guidance((await restarted.run('after-stop', 'Other work'))[0]), undefined);
  assert.equal(f.plan.getPlan('session').revision, revision, 'stop never clears or completes native plan nodes');
});

test('usage guards are scoped, required before loading, block before effects and leave on stop/disable', async t => {
  const guardCode = 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:p.tool_input?.allow===true?"allow":"deny",permissionDecisionReason:"fixture boundary"}}));';
  const f = await setup(t, { PreToolUse: [{ matcher: 'fixture_effect|run_plugin_command', hooks: [{ type: 'command', command: process.execPath, args: ['-e', guardCode], timeout: 5 }] }] });
  const r = f.runtime();
  await r.run('before-use', 'Ordinary task', [effect(false)]); assert.equal(r.effects.length, 1);
  const untrusted = await r.run('untrusted', f.bundle.activation);
  assert.equal(guidance(untrusted[0]), undefined);
  assert.ok(untrusted[0].messages.some(message => message.role === 'tool' && message.content.includes('usage_guard_unavailable')));
  await f.trust();
  await r.run('use', f.bundle.activation);
  const blocked = await r.run('blocked', 'Follow the manual', [effect(false)]);
  assert.equal(r.effects.length, 1);
  assert.ok(blocked.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('fixture boundary')));
  await r.run('allowed', 'Continue', [effect(true)]); assert.equal(r.effects.length, 2);
  await r.run('other-session', 'Independent task', [effect(false)], 'other'); assert.equal(r.effects.length, 3);
  // A new manual definition cannot silently retain prior guard authority.
  const path = join(f.installed, f.bundle.plugin_id, 'usage.json'), changed = definition(); changed.nodes[0].instruction = 'New version.';
  await writeFile(path, JSON.stringify(changed));
  await r.run('changed', 'Continue', [effect(true)]); assert.equal(r.effects.length, 3);
  await r.run('reload', f.bundle.activation);
  await r.run('allowed-again', 'Continue', [effect(true)]); assert.equal(r.effects.length, 4);
  await r.run('stop', f.bundle.deactivation);
  await r.run('after-stop', 'Other task', [effect(false)]); assert.equal(r.effects.length, 5, 'old guard cannot intercept its user-only stop command');
  await r.run('use-again', f.bundle.activation);
  await f.trust(false);
  assert.equal(guidance((await r.run('disabled', 'Other task', [effect(false)]))[0]), undefined);
  assert.equal(r.effects.length, 6, 'disabling the plugin withdraws its scoped hooks and manual together');
});

test('usage guard failures and indeterminate output never authorize an effect', async t => {
  const root = await temporary(t), runner = new PluginHookRunner(root);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', tools: [], messages: [], metadata: { workspaceDir: root } };
  for (const code of ['process.exit(1)', '', 'console.log("not a verdict")', 'console.log(JSON.stringify({decision:"unknown"}))']) {
    const hook = { id: 'guard', pluginId: 'usage-fixture', root, scope: { kind: 'usage', id: 'usage-fixture:use' }, event: 'PreToolUse', matcher: '*',
      type: 'command', command: process.execPath, args: ['-e', code], trusted: true, timeout: 5 };
    const result = await runner.run([hook], 'PreToolUse', { request, toolName: 'write_file', input: {} });
    assert.match(result.blocked, /guard could not complete/);
  }
  await runner.close();
});

test('the old manual cannot block a user stop command through session-start or prompt hooks', async t => {
  const hook = value => [{ hooks: [{ type: 'command', command: process.execPath,
    args: ['-e', `console.log(${JSON.stringify(JSON.stringify(value))});`], timeout: 5 }] }];
  const f = await setup(t, { SessionStart: hook({ continue: false, stopReason: 'fixture session boundary' }),
    UserPromptSubmit: hook({ decision: 'block', reason: 'fixture prompt boundary' }) });
  await f.trust();
  await f.runtime().run('use', f.bundle.activation);
  const resumed = f.runtime();
  await assert.rejects(resumed.run('ordinary', 'Ordinary task'), /plugin_hook_stopped/);
  await assert.rejects(resumed.run('ordinary-again', 'Ordinary task'), /plugin_hook_blocked/);
  const next = f.runtime();
  await next.run('stop', f.bundle.deactivation);
  assert.equal(guidance((await next.run('after-stop', 'Continue independently'))[0]), undefined);
});

test('package loader rejects escaping files, malformed manuals and asynchronous guards before activation', async t => {
  const f = await setup(t);
  const path = join(f.source, 'commands/use.md'), original = await readFile(path, 'utf8');
  await writeFile(join(f.root, 'outside.json'), JSON.stringify(definition()));
  await writeFile(path, original.replace('./usage.json', '../outside.json'));
  assert.ok((await resolvePluginManifest(f.source)).issues.length);
  await writeFile(path, original);
  await writeFile(join(f.source, 'usage.json'), JSON.stringify({ ...definition(), plan: ['missing'] }));
  assert.ok((await resolvePluginManifest(f.source)).issues.length);
  await writeFile(join(f.source, 'usage.json'), JSON.stringify(definition()));
  const hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', ''], async: true }] }] };
  await writeFile(path, original.replace('usage: ./usage.json\n', `usage: ./usage.json\nhooks: ${JSON.stringify(hooks)}\n`));
  assert.ok((await resolvePluginManifest(f.source)).issues.some(issue => /synchronous/.test(issue.detail)));
});

test('loading a manual never executes quoted shell examples as dynamic command context', async t => {
  const f = await setup(t);
  const path = join(f.installed, f.bundle.plugin_id, 'commands/use.md');
  await writeFile(path, (await readFile(path, 'utf8')) + '\nHistorical example: !`echo not-an-action`\n```!\necho not-an-action\n```\n');
  const r = f.runtime(), requests = await r.run('literal', `${f.bundle.activation} Keep this user's literal parameters`);
  assert.equal(guidance(requests[0]).enabled, true);
  assert.ok(requests[0].messages.some(message => message.role === 'tool' && message.content.includes('!`echo not-an-action`')));
  assert.ok(!r.host.events('session', 'literal').some(event => event.kind === 'tool_failed'));
});

test('actual checkpoint compaction restores native-node guidance and scoped lifecycle hooks', async t => {
  const hooks = Object.fromEntries(['PreCompact', 'PostCompact', 'SessionStart'].map(event => [event, [{ matcher: event === 'SessionStart' ? '^compact$' : '^auto$', hooks: [{
    type: 'command', command: process.execPath, args: ['-e', `require("node:fs").appendFileSync(require("node:path").join(process.env.CARDBUSH_PLUGIN_ROOT,"lifecycle.log"),${JSON.stringify(`${event}\n`)});`], timeout: 5,
  }] }]]));
  const f = await setup(t, hooks); await f.trust();
  const r = f.runtime(async request => ({ inputTokens: request.messages.some(message => message.role === 'tool' && message.toolCallId === 'second-0') ? 100
    : request.messages.some(message => message.name === 'context_pressure') ? 2900 : 2860, source: 'provider' }));
  await r.runSession('first', f.bundle.activation, [request => {
    const template = guidance(request).plan.plan_template.input;
    return call('update_task_plan', { ...template, nodes: template.nodes.map((node, index) => ({ ...node, status: index ? 'in_progress' : 'completed' })) });
  }]);
  const revision = f.plan.getPlan('session').revision;
  const requests = await r.runSession('second', 'Continue the inspection.', [request => {
    assert.ok(request.messages.some(message => message.name === 'context_pressure'));
    return call('checkpoint_context', { updates: [
      { source: 0, summary: 'The user selected the document usage manual. Its native plan records Make completed and Inspect in progress. The requested next action is to inspect the actual result. Manual and native plan remain in persistent runtime state.' },
      { source: 1, summary: 'The current user asked to continue the inspection. Session resume hooks have been processed; no new document work has occurred yet.' },
    ] });
  }], { maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000, workspaceDir: f.root } });
  assert.ok(r.host.events('session', 'second').some(event => event.kind === 'context_compaction_completed'));
  assert.equal(guidance(requests.at(-1)).plan.current_node, 'inspect');
  assert.deepEqual(guidance(requests.at(-1)).selected.map(node => node.id), ['inspect']);
  assert.equal(f.plan.getPlan('session').revision, revision);
  assert.equal(await readFile(join(f.installed, f.bundle.plugin_id, 'lifecycle.log'), 'utf8'), 'PreCompact\nPostCompact\nSessionStart\n');
});
