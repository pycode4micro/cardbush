// Opt-in real-provider interruption check. Uses isolated sessions and never modifies user configuration.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryRuntimeHost, ToolRegistry, SessionStore, SubagentTaskStore } from '@cardbush/bush-runtime';
import { ModelProviderRegistry, createModelProvider } from '@cardbush/bush-provider-openai';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { PERSONAL_ASSISTANT_SESSION, assistantProfileSchema } from '@cardbush/bush-protocol';
import { unprotectConfiguration } from '@cardbush/platform/credentials';

if (!process.argv.includes('--run')) throw Error('Pass --run to use the configured DeepSeek API.');
const path = resolve(process.env.BUSH_LIVE_MODEL_CONFIG_PATH || join(process.env.APPDATA || '', 'cardbush/product-host/config/models.json'));
const original = await readFile(path), config = unprotectConfiguration(JSON.parse(original));
const selected = config.models.find(model => model.id === (process.env.BUSH_LIVE_MODEL_ID || config.defaultModelId));
assert.ok(selected?.apiKey && /deepseek/i.test(selected.model));
const root = resolve('tmp', `assistant-guidance-live-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
await mkdir(root, { recursive: true });
const scrub = value => String(value).replaceAll(selected.apiKey, '[redacted]');
const report = { model: selected.model, adapter: selected.apiProtocol, root, scenarios: [] };
const until = async predicate => {
  const deadline = Date.now() + 180000;
  while (!await predicate()) { if (Date.now() > deadline) throw Error('Live guidance timed out'); await sleep(50); }
};

for (const ordinary of [false, true]) {
  const name = ordinary ? 'ordinary-conversation' : 'assistant', sessionId = ordinary ? randomUUID() : PERSONAL_ASSISTANT_SESSION;
  const directory = join(root, name), registry = new ToolRegistry(), tasks = new SubagentTaskStore(), sessions = new SessionStore();
  await mkdir(directory, { recursive: true }); sessions.ensureSession(sessionId);
  const trace = new AsyncLocalStorage(), release = Promise.withResolvers(), admitted = Promise.withResolvers();
  const requests = [], http = []; let firstReached = false, host;
  const providers = new ModelProviderRegistry({ createProvider: providerConfig => createModelProvider({ ...providerConfig, timeoutMs: 180000,
    fetch: async (input, init) => {
      const number = trace.getStore(), url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const item = { number, path: url.pathname, status: undefined };
      http.push(item);
      const response = await globalThis.fetch(input, init); item.status = response.status;
      // Hold the first real HTTP response before the model can commit its old decision.
      // The replacement still uses the unmodified production provider and loop.
      if (number === 1 && !firstReached) { firstReached = true; admitted.resolve(); await release.promise; }
      return response;
    },
  }) });
  const binding = providers.upsert({ protocol: 'bush.provider_binding_config.v1', bindingId: name, adapter: selected.apiProtocol,
    apiKey: selected.apiKey, baseURL: selected.baseURL || selected.baseUrl, defaultHeaders: {} });
  const provider = {
    estimateInputTokens: (request, options) => providers.estimateInputTokens(request, options),
    countInputTokens: (request, options) => providers.countInputTokens(request, options),
    async *stream(request, options) {
      const item = { number: requests.length + 1, id: request.requestId, text: '', calls: [], aborted: false };
      requests.push(item);
      const iterator = providers.stream(request, options)[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await trace.run(item.number, () => iterator.next());
          if (next.done) break;
          if (next.value.kind === 'text_delta') item.text += next.value.delta;
          if (next.value.kind === 'tool_call_delta') item.calls.push(next.value.nameDelta);
          yield next.value;
        }
      } finally { item.aborted = options.signal?.aborted === true; await iterator.return?.(); }
    },
  };
  host = new InMemoryRuntimeHost({ dataRoot: directory, provider, toolRegistry: registry, sessionStore: sessions, subagentTaskStore: tasks });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
  const turnId = randomUUID(), createdAt = new Date().toISOString();
  const parent = createProductAgentTurnRequest({ requestId: turnId, sessionId, turnId, messageId: turnId, createdAt,
    timeZone: 'Asia/Shanghai', uiLanguage: 'zh', userText: '请派一个本地子代理，只读检查当前工作目录下有哪些文件，检查完成后告诉我。',
    model: selected.model, providerBinding: binding.binding, tools: registry.definitions(), workspaceDir: directory,
    permissionMode: 'ask_for_approval', individuation: { habits: false, predictions: false }, maxOutputTokens: 2048,
    ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) });
  let run;
  const item = { name, success: false, requests, http };
  try {
    if (ordinary) run = host.runSessionTurn(parent);
    else await command({ action: 'turn', parent, profile: assistantProfileSchema.parse({}), entry: { id: turnId, role: 'user',
      content: parent.inputMessages.at(-1).message.content, source: 'text', visibility: 'conversation', createdAt } });
    await until(() => firstReached); await admitted.promise;
    const messageId = randomUUID(), content = '取消刚才的检查，不要派子代理，不要调用任何工具。只回复：已取消这次检查。';
    if (ordinary) await host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: { protocol: 'bush.runtime_guidance.v1',
      sessionId, turnId, messageId, content, createdAt: new Date().toISOString(), mode: 'interrupt_and_continue' } });
    else await command({ action: 'turn', parent: { ...parent, turnId: messageId }, profile: assistantProfileSchema.parse({}), entry: {
      id: messageId, role: 'user', content, source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() } });
    release.resolve();
    if (ordinary) assert.equal((await run).payload.status, 'completed');
    else await until(async () => { const state = await command({ action: 'read' }); if (state.error) throw Error(state.error); return !state.busy; });
    await sleep(2600);
    const replies = ordinary ? sessions.snapshot(sessionId).turns.flatMap(turn => turn.messages)
      .filter(fact => fact.message.role === 'assistant' && !fact.message.toolCalls.length && fact.message.content.trim()).map(fact => fact.message.content)
      : (await command({ action: 'read' })).entries.filter(entry => entry.role === 'assistant').map(entry => entry.content);
    assert.equal(tasks.list(sessionId).length, 0, 'obsolete reasoning must not dispatch a child');
    assert.equal(requests.length, 2, 'one interrupted request and one necessary continuation');
    assert.equal(requests[0].aborted, true); assert.equal(requests[1].aborted, false);
    assert.equal(replies.length, 1); assert.match(replies[0], /取消/);
    for (const request of requests) {
      const sent = http.filter(item => item.number === request.number);
      assert.equal(sent.length, 1, 'no duplicate HTTP submission or retry'); assert.equal(sent[0].status, 200);
    }
    Object.assign(item, { success: true, replies, dispatches: 0 });
  } catch (error) { item.failure = scrub(error.stack ?? error); }
  finally { release.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
  report.scenarios.push(item);
  console.log(scrub(JSON.stringify(item)));
}
assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), createHash('sha256').update(original).digest('hex'));
await writeFile(join(root, 'verification.json'), scrub(JSON.stringify(report, null, 2)) + '\n');
assert.ok(report.scenarios.every(item => item.success), `See ${root}`);
