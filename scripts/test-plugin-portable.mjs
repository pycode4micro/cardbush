import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';
import { installProductPlugin, loadProductPluginCatalog, loadEnabledProductPluginMcpServers, loadEnabledProductPluginExtensions, loadEnabledProductPluginSkillRoots } from '../dist-electron/productPlugins.js';
import { listProductSkills } from '../dist-electron/productSkills.js';
import { PluginHookRunner } from '../packages/bush-runtime/dist/pluginHookRunner.js';
import { InMemoryRuntimeHost } from '../packages/bush-runtime/dist/index.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-portable-plugin-'));
const source = join(root, 'source', 'portable-demo'), installed = join(root, 'installed');
const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const manifest = { $schema: pluginSchema, name: 'portable-demo', description: 'Portable fixture', extensions: { 'com.openai': {
  interface: { displayName: 'Portable demo' }, hooks: [], skills: './ignored', mcpServers: './ignored.json',
} } };
const save = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); };
try {
  await save(join(source, 'plugin.json'), manifest);
  await save(join(source, '.codex-plugin/plugin.json'), '{ invalid overlay must not be read');
  await save(join(source, 'mcp.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { docs: { type: 'streamable-http', url: 'https://example.test/mcp' } } });
  await save(join(source, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nRead the sibling reference.');
  await save(join(source, 'hooks/hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Not selected' }] }] } });
  await save(join(source, 'agents/ignored.md'), '---\nname: ignored\n---\nThis is not a portable component.');
  const before = await readFile(join(source, 'plugin.json'), 'utf8');
  const resolved = await resolvePluginManifest(source);
  assert.equal(resolved.format, 'agent-plugins');
  assert.equal(resolved.manifest.name, manifest.name);
  assert.equal(resolved.manifest.version, '0.0.0');
  assert.equal(resolved.manifest.interface.displayName, 'Portable demo');
  assert.deepEqual({ ...resolved.extensions, skills: [] }, { hooks: [], agents: [], commands: [], skills: [], issues: [], notes: [] });
  assert.equal(resolved.extensions.skills[0].id, 'portable-demo:hello');
  assert.equal(resolved.manifest.mcpServers.docs.type, 'streamable_http');
  assert.deepEqual(resolved.skillRoots, [join(source, 'skills')]);
  assert.equal(await readFile(join(source, 'plugin.json'), 'utf8'), before, 'resolution is read-only');
  const result = await installProductPlugin(source, installed);
  assert.equal(result.manifestPath, join(installed, manifest.name, 'plugin.json'));
  const roots = [{ path: installed, source: 'user' }], config = join(root, 'apps.json');
  const catalog = await loadProductPluginCatalog(roots);
  assert.deepEqual(catalog[0].components.map(item => item.kind).sort(), ['mcp', 'skill']);
  assert.equal((await loadEnabledProductPluginMcpServers(roots, config))[0].transport.kind, 'streamable_http');
  assert.equal((await listProductSkills(await loadEnabledProductPluginSkillRoots(roots, config)))[0].name, 'portable-demo:hello');
  const loaded = await loadEnabledProductPluginExtensions(roots, config);
  assert.deepEqual({ ...loaded, skills: [] }, { agents: [], commands: [], hooks: [], skills: [] });
  assert.equal(loaded.skills[0].id, 'portable-demo:hello');
  // Without an inline OpenAI object, the overlay supplies settings but never identity/components.
  delete manifest.extensions;
  await save(join(source, 'plugin.json'), manifest);
  await save(join(source, '.codex-plugin/plugin.json'), { name: 'wrong-name', version: '9.0', skills: './ignored', mcpServers: { wrong: {} }, hooks: [], interface: { displayName: 'Overlay title' } });
  const fallback = await resolvePluginManifest(source);
  assert.equal(fallback.manifest.name, 'portable-demo');
  assert.equal(fallback.manifest.interface.displayName, 'Overlay title');
  assert.deepEqual(Object.keys(fallback.manifest.mcpServers), ['docs']);
  await save(join(source, 'plugin.json'), { ...manifest, $schema: pluginSchema.replace('1.0.0', '2.0.0') });
  await assert.rejects(resolvePluginManifest(source), /Unsupported Agent Plugins schema/);
  await save(join(source, 'plugin.json'), { ...manifest, extensions: { 'com.openai': { hooks: './hooks/selected.json' } } });
  await save(join(source, 'hooks/selected.json'), { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: ['${PLUGIN_ROOT}/hooks/stop.cjs'] }] }] } });
  await save(join(source, 'hooks/stop.cjs'), 'if (!process.env.PLUGIN_ROOT || process.env.PLUGIN_ROOT !== process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_DATA !== process.env.CLAUDE_PLUGIN_DATA) process.exit(1); console.log(JSON.stringify({continue:false,stopReason:"Finished by hook"}));');
  const hooks = (await resolvePluginManifest(source)).extensions.hooks;
  assert.equal(hooks.length, 1, 'explicit hook paths replace default discovery and * is a valid matcher');
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free',
    messages: [{ role: 'user', content: 'Finish this task.' }], tools: [], metadata: { workspaceDir: root } };
  const runner = new PluginHookRunner(join(root, 'runtime'));
  const stopped = await runner.run(hooks, 'Stop', { request });
  assert.match(stopped.stopTurn, /Finished by hook/);
  assert.equal(stopped.continueTurn, undefined);
  assert.equal(stopped.blocked, undefined);
  let rounds = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'host'), registerDefaultWorkspaceTools: false,
    loadPluginExtensions: async () => ({ hooks, agents: [] }), provider: { async *stream(req) {
      rounds++;
      const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Completed.' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    } } });
  const terminal = await host.runModelTurn(request);
  assert.equal(rounds, 1, 'continue:false does not prompt the model again');
  assert.equal(terminal.payload.reason, 'plugin_hook_stopped');
  assert.equal(terminal.payload.status, 'stopped');
  const continueHook = { ...hooks[0], id: 'continue', args: ['-e', 'console.log(JSON.stringify({decision:"block",reason:"Review again"}))'] };
  const combined = await runner.run([continueHook, ...hooks], 'Stop', { request });
  assert.ok(combined.stopTurn && combined.continueTurn, 'the host gives an explicit stop precedence over continuation');
  assert.ok(!(await readdir(source)).includes('.cardbush-imported-skills'));
  console.log('Portable plugins passed: canonical identity, overlay precedence, fixed components, immutable manifests, installed discovery, hook selection/environment, and Stop semantics.');
} finally {
  assert.ok(root.startsWith(parent + sep + 'cardbush-portable-plugin-'));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
