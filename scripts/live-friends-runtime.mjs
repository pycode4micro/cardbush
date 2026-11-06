// Opt-in real-provider integration check. All state and output stay in a new temporary directory.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryRuntimeHost, ToolRegistry, SessionStore } from '@cardbush/bush-runtime';
import { ModelProviderRegistry } from '@cardbush/bush-provider-openai';
import { FRIENDS_COMMAND, FRIENDS_SESSION } from '@cardbush/bush-protocol';
import { unprotectConfiguration } from '@cardbush/platform/credentials';

if (!process.argv.includes('--run')) throw Error('Pass --run to use the configured model for an isolated live check.');
const configPath = resolve(process.env.BUSH_LIVE_MODEL_CONFIG_PATH || join(process.env.APPDATA || '', 'cardbush/product-host/config/models.json'));
const config = unprotectConfiguration(JSON.parse(await readFile(configPath, 'utf8')));
const selected = config.models?.find(item => item.id === (process.env.BUSH_LIVE_MODEL_ID || config.defaultId || config.defaultModelId || config.default_model_id)) ?? config.models?.[0];
if (!selected?.apiKey) throw Error('The selected model needs an API credential for this live check.');
const providers = new ModelProviderRegistry();
const binding = providers.upsert({ protocol: 'bush.provider_binding_config.v1', bindingId: 'friends-live',
  adapter: selected.apiProtocol || 'openai_responses', apiKey: selected.apiKey, baseURL: selected.baseURL || selected.baseUrl, defaultHeaders: {} });
assert.equal(binding.status, 'configured');
const root = await mkdtemp(join(tmpdir(), 'cardbush-friends-live-')), workspace = join(root, 'workspace');
await mkdir(workspace); await writeFile(join(workspace, 'source.txt'), 'quantity=7\nunit_price=12\n', 'utf8');
const registry = new ToolRegistry(), sessions = new SessionStore(), requests = [];
sessions.ensureSession(FRIENDS_SESSION, { hidden: true, friends: true });
const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolRegistry: registry, sessionStore: sessions, maxAttempts: 1,
  provider: { async *stream(request, options) {
    requests.push({ at: new Date().toISOString(), turnId: request.turnId, eventId: request.metadata.friendsEventId,
      tools: request.tools.map(tool => tool.name) });
    yield* providers.stream(request, options);
  } } });
const command = payload => host.sendCommand({ kind: FRIENDS_COMMAND, payload });
async function until(predicate) {
  const end = Date.now() + 240_000;
  while (Date.now() < end) {
    const state = await command({ action: 'read' });
    const failed = state.events.find(event => event.status === 'failed');
    if (failed) throw Error(`Friends execution failed: ${failed.error}`);
    if (predicate(state)) return state;
    await sleep(300);
  }
  throw Error('Live check exceeded its bounded wait.');
}
let success = false, failure;
try {
  await command({ action: 'configure', profile: { name: 'Live test', language: 'en', timeZone: 'Asia/Shanghai',
    recognition: { context: 'This is an isolated live integration test, with no saved habits or ongoing tasks.' }, confirmedAt: new Date().toISOString() },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'live-config', sessionId: FRIENDS_SESSION, turnId: 'live-config',
      model: selected.model || selected.modelName, providerBinding: binding.binding, reasoningEffort: 'low', maxOutputTokens: 2000,
      permissionMode: 'task_free', prefixMessages: [{ role: 'developer', content: 'For the startup event, record completed and return Ready. No files or future work are needed at startup. For subsequent input events, carry out the explicit isolated test instructions using real tools.' }],
      inputMessages: [{ messageId: 'configuration-only', message: { role: 'user', content: 'Configure the isolated test.' } }], tools: registry.definitions().filter(tool => ['read_file', 'write_file'].includes(tool.name)),
      metadata: { workspaceDir: workspace }, requestCapabilities: { interactiveRequests: false, vision: false } } });
  await until(state => state.events[0]?.status === 'completed');
  await command({ action: 'submit', input: { id: 'file-test', createdAt: new Date().toISOString(),
    text: `Read ${join(workspace, 'source.txt')} with read_file. Write ${join(workspace, 'report.txt')} using write_file: exactly "total=84\\n" with a real newline at the end. Then mark this event completed and return the report path.` } });
  await until(state => state.events.find(event => event.id === 'file-test')?.status === 'completed');
  assert.equal(await readFile(join(workspace, 'report.txt'), 'utf8'), 'total=84\n');
  const at = new Date(Date.now() + 30_000).toISOString();
  await command({ action: 'submit', input: { id: 'clock-test', createdAt: new Date().toISOString(),
    text: `Register a friends_watch_time detection on this current event for ${at}, then record watching and return a short waiting status. When the clock signal actually wakes this same event, read ${join(workspace, 'report.txt')} with read_file, record completed and return the verified total. Do not create a separate event.` } });
  const waiting = await until(state => state.events.find(event => event.id === 'clock-test')?.status === 'watching');
  assert.equal(waiting.detections.length, 1); const count = requests.length;
  const idleMs = Math.min(2000, Math.max(0, Date.parse(at) - Date.now() - 500));
  assert.ok(idleMs >= 100, 'The live model must register before the requested time.');
  await sleep(idleMs); assert.equal(requests.length, count, 'Waiting must not issue model requests.');
  await until(state => state.events.find(event => event.id === 'clock-test')?.status === 'completed');
  success = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  const snapshot = await command({ action: 'read' });
  const turns = [...new Set(requests.map(request => request.turnId))];
  const receipts = turns.flatMap(turn => host.events(FRIENDS_SESSION, turn)).filter(event =>
    ['tool_call_completed', 'tool_call_failed', 'turn_terminal', 'tool_call_requested', 'tool_returned'].includes(event.kind));
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  const reportPath = join(root, 'verification.json');
  await writeFile(reportPath, JSON.stringify({ success, failure, model: selected.model || selected.modelName,
    workspace, requests, snapshot, receipts }, null, 2));
  console.log(JSON.stringify({ success, failure, reportPath, modelRequests: requests.length, activations: turns.length }));
}
if (!success) process.exitCode = 1;
