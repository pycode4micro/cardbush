// Opt-in live check: production Assistant loop/provider, isolated files and journals.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryRuntimeHost, ToolRegistry, SessionStore, SubagentTaskStore } from '@cardbush/bush-runtime';
import { ModelProviderRegistry, createModelProvider } from '@cardbush/bush-provider-openai';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { PERSONAL_ASSISTANT_SESSION, assistantProfileSchema } from '@cardbush/bush-protocol';
import { unprotectConfiguration } from '@cardbush/platform/credentials';
import { ConversationJournal } from '../packages/bush-runtime/dist/conversationJournal.js';

if (!process.argv.includes('--run')) throw Error('Pass --run to call the configured DeepSeek API.');
const configPath = resolve(process.env.BUSH_LIVE_MODEL_CONFIG_PATH || join(process.env.APPDATA || '', 'cardbush/product-host/config/models.json'));
const configBytes = await readFile(configPath);
const config = unprotectConfiguration(JSON.parse(configBytes.toString('utf8')));
const modelId = process.env.BUSH_LIVE_MODEL_ID || config.defaultModelId;
const selected = config.models?.find(model => model.id === modelId);
assert.ok(selected?.apiKey && /deepseek/i.test(selected.model), 'Select a configured DeepSeek API-key model.');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const root = resolve('tmp', `assistant-deepseek-live-${stamp}`);
await mkdir(root, { recursive: true });
const scrub = text => String(text).replaceAll(selected.apiKey, '[redacted]');
const save = (path, value) => writeFile(path, scrub(JSON.stringify(value, null, 2)) + '\n', 'utf8');
const log = value => console.log(scrub(JSON.stringify(value)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { startedAt: new Date().toISOString(), root,
  model: { id: selected.id, model: selected.model, adapter: selected.apiProtocol, host: new URL(selected.baseURL || selected.baseUrl).hostname },
  method: 'Real production Assistant/ordinary conversation and child model calls. Assistant child starts are gated until its foreground reply. Ordinary children run immediately in the current turn; completion may be joined asynchronously or consumed by a foreground task query. No model responses or tool receipts are mocked.',
  scenarios: [] };

async function scenario(name, advanced, ordinaryChat = false) {
  const sessionId = ordinaryChat ? `live-${name}` : PERSONAL_ASSISTANT_SESSION;
  const notificationName = ordinaryChat ? 'subagent_result' : 'background_task_result';
  const directory = join(root, name), workspace = join(directory, 'workspace'), dataRoot = join(directory, 'runtime');
  await mkdir(workspace, { recursive: true });
  const quantity = advanced ? 9 : 7, unitPrice = advanced ? 13 : 12, expectedTotal = quantity * unitPrice;
  const marker = `VERIFY_${randomUUID().replaceAll('-', '')}`;
  const source = join(workspace, 'source.txt');
  const sourceContent = `quantity=${quantity}\nunit_price=${unitPrice}\nverification_code=${marker}\n`;
  await writeFile(source, sourceContent, 'utf8');
  const requests = [], http = [], executions = [], captures = [], checkpoints = [];
  const trace = new AsyncLocalStorage(), childGate = Promise.withResolvers();
  let phase = 'foreground', number = 0, host, ordinaryFailure = '', ordinaryActive = 0;
  const ordinaryRuns = [];
  const result = { name, advanced, surface: ordinaryChat ? 'ordinary-conversation' : 'assistant', expectedTotal, marker, workspace, success: false, requests, http, executions, checkpoints };
  const providers = new ModelProviderRegistry({ createProvider: providerConfig => createModelProvider({
    ...providerConfig, timeoutMs: 180000,
    fetch: async (input, init) => {
      const context = trace.getStore();
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const rawBody = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
      const index = http.length + 1;
      const entry = { index, requestNumber: context?.number, phase: context?.phase ?? phase,
        role: context?.role ?? 'token-estimation', method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        path: url.pathname, startedAt: new Date().toISOString(), bodyHash: digest(rawBody) };
      http.push(entry);
      if (rawBody) await writeFile(join(directory, `http-${index}-request.json`), scrub(rawBody), 'utf8');
      try {
        const response = await globalThis.fetch(input, init);
        entry.status = response.status;
        entry.providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid');
        captures.push(response.clone().text().then(async text => {
          entry.finishedAt = new Date().toISOString(); entry.responseBytes = Buffer.byteLength(text);
          await writeFile(join(directory, `http-${index}-response.txt`), scrub(text), 'utf8');
        }).catch(error => { entry.captureError = scrub(error.message); }));
        return response;
      } catch (error) { entry.error = scrub(error.message); throw error; }
    },
  }) });
  const binding = providers.upsert({ protocol: 'bush.provider_binding_config.v1', bindingId: `assistant-live-${name}`,
    adapter: selected.apiProtocol, apiKey: selected.apiKey, baseURL: selected.baseURL || selected.baseUrl, defaultHeaders: {} });
  assert.equal(binding.status, 'configured');
  const registry = new ToolRegistry(), sessions = new SessionStore(), tasks = new SubagentTaskStore();
  sessions.ensureSession(sessionId);
  const provider = {
    estimateInputTokens: (request, options) => providers.estimateInputTokens(request, options),
    countInputTokens: (request, options) => providers.countInputTokens(request, options),
    async *stream(request, options) {
      const role = request.metadata.agentRole === 'child' ? 'child' : request.sessionId === sessionId ? 'assistant' : 'internal';
      const requestPhase = ordinaryChat && phase === 'foreground' && role === 'assistant' && request.messages.some(message => message.name === notificationName) ? 'completion' : phase;
      const entry = { number: ++number, role, phase: requestPhase, requestId: request.requestId, sessionId: request.sessionId,
        turnId: request.turnId, startedAt: new Date().toISOString(), tools: [], text: '', failures: [],
        notificationMessages: request.messages.filter(message => message.name === notificationName).map(message => message.content) };
      requests.push(entry);
      await save(join(directory, `model-${entry.number}-request.json`), request);
      if (role === 'child') await childGate.promise;
      log({ scenario: name, event: 'model-start', number: entry.number, role, phase: entry.phase });
      const events = [], calls = new Map();
      const iterator = providers.stream(request, options)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await trace.run(entry, () => iterator.next());
          if (next.done) break;
          const event = next.value;
          events.push(event);
          if (event.kind === 'text_delta') entry.text += event.delta;
          if (event.kind === 'tool_call_delta') {
            const call = calls.get(event.index) ?? { id: '', name: '', arguments: '' };
            call.id += event.toolCallId ?? ''; call.name += event.nameDelta ?? ''; call.arguments += event.argumentsDelta ?? '';
            calls.set(event.index, call);
          }
          if (event.kind === 'response_failed') entry.failures.push({ code: event.code, message: event.message, retryable: event.retryable });
          if (event.kind === 'response_completed') entry.finishReason = event.finishReason;
          if (event.kind === 'usage') entry.usage = event;
          yield event;
        }
      } finally {
        await iterator.return?.();
        entry.finishedAt = new Date().toISOString(); entry.tools = [...calls.values()];
        await save(join(directory, `model-${entry.number}-events.json`), events);
        log({ scenario: name, event: 'model-end', number: entry.number, role, phase: entry.phase,
          tools: entry.tools.map(call => call.name), failures: entry.failures.length });
      }
    },
  };
  host = new InMemoryRuntimeHost({ dataRoot, provider, toolRegistry: registry, sessionStore: sessions, subagentTaskStore: tasks });
  for (const definition of registry.definitions()) {
    const registration = registry.resolve(definition.name), execute = registration.execute;
    registration.execute = async context => {
      const entry = { number: executions.length + 1, name: definition.name, sessionId: context.sessionId,
        phase, input: structuredClone(context.input), startedAt: new Date().toISOString() };
      executions.push(entry);
      try {
        const value = await execute(context); entry.status = 'returned';
        entry.result = JSON.parse(JSON.stringify(value) ?? 'null'); return value;
      } catch (error) { entry.status = 'failed'; entry.error = scrub(error.message); throw error; }
      finally { entry.finishedAt = new Date().toISOString(); }
    };
  }
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
  const visible = state => state.entries.filter(entry => entry.role === 'assistant' && entry.visibility !== 'internal');
  const parents = () => requests.filter(entry => entry.role === 'assistant');
  const read = async () => {
    if (!ordinaryChat) return command({ action: 'read' });
    // Ordinary turns can defer the final-display marker while joining a child.
    // Observe completed no-tool replies to release the test gate, then validate
    // them against the committed Runtime history below.
    return { busy: parents().some(request => !request.finishedAt), error: ordinaryFailure,
      entries: [
        ...parents().filter(request => request.finishedAt && !request.tools.length && request.text.trim()).map(request => ({
          id: `model-${request.number}`, role: 'assistant', content: request.text, createdAt: request.finishedAt, source: 'text', visibility: 'conversation',
        })),
        ...(parents().at(-1)?.notificationMessages ?? []).map((content, index) => ({ id: `completion-${index}`, role: 'user', source: 'task', visibility: 'internal', content })),
      ] };
  };
  const waitFor = async (label, predicate) => {
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
      const state = await read();
      if (state.error) throw Error(`${label}: ${state.error}`);
      if (state.management?.permissions?.length) throw Error('Unexpected permission request in isolated read-only work.');
      if (await predicate(state)) return state;
      await sleep(250);
    }
    throw Error(`${label} exceeded six minutes.`);
  };
  const snapshot = async label => {
    const state = await read();
    checkpoints.push({ label, at: new Date().toISOString(), parentRequests: parents().length, httpRequests: http.length,
      replies: visible(state).map(({ id, content, createdAt }) => ({ id, content, createdAt })),
      taskNotices: state.entries.filter(entry => entry.source === 'task').length,
      tasks: tasks.list(sessionId).map(({ taskId, status, finalResponse }) => ({ taskId, status, finalResponse })) });
    return checkpoints.at(-1);
  };
  const turn = async text => {
    const id = randomUUID(), createdAt = new Date().toISOString();
    const parent = createProductAgentTurnRequest({ requestId: id, sessionId, turnId: id, messageId: id, createdAt,
      timeZone: 'Asia/Shanghai', uiLanguage: 'zh', userText: text, model: selected.model, providerBinding: binding.binding,
      tools: registry.definitions(), workspaceDir: workspace, permissionMode: 'task_free', planEnabled: true,
      individuation: { habits: false, predictions: false }, maxOutputTokens: 4096,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) });
    if (ordinaryChat) {
      ordinaryActive++;
      ordinaryRuns.push(host.runSessionTurn(parent).then(terminal => {
        if (terminal.payload.status !== 'completed') ordinaryFailure = JSON.stringify(terminal.payload);
      }).catch(error => { ordinaryFailure = scrub(error.message); }).finally(() => { ordinaryActive--; }));
    }
    else await command({ action: 'turn', parent, profile: assistantProfileSchema.parse({}),
      entry: { id, role: 'user', source: 'text', visibility: 'conversation', content: text, createdAt } });
  };
  try {
    const task = `读取 ${source}，计算 quantity × unit_price，并把文件中的 verification_code 原样带回。只读这个文件，不修改文件，不访问远程主机或外部服务。`;
    const prompt = advanced
      ? `请先读取子代理工具的完整定义，再按定义提供的调用方式派一个不继承当前对话上下文的临时子代理，单独指定系统指令为“你是只读核算员，只根据本次任务文件核算；返回乘积和文件中的验证代码”。无需保存员工。任务：${task}先告诉我已派发，完成后再通知我，不用查询等待任务。`
      : `请派一个本地子代理完成这个任务：${task}先告诉我已派发，完成后再通知我，不用查询等待任务。`;
    // Detached background work has next-turn delivery in ordinary sessions.
    // This case exercises the default asynchronous result join in the current turn.
    const executionPrompt = ordinaryChat ? `${prompt}普通会话本次保持默认的当前轮次委派：不要设置 run_in_background=true；省略该字段或明确设为 false，不要将任务转为跨轮后台工作。` : prompt;
    result.userPrompt = executionPrompt;
    // Ordinary agents can explicitly await a child; delaying that child until
    // a final reply would create artificial polling. Let it run immediately.
    if (ordinaryChat) childGate.resolve();
    await turn(executionPrompt);
    if (!ordinaryChat) {
      await waitFor('foreground reply', state => !state.busy && visible(state).length >= 1);
      const foreground = await snapshot('foreground-settled');
      assert.equal(foreground.replies.length, 1, 'one foreground reply');
      assert.equal(tasks.list(sessionId).length, 1, 'one child task');
      assert.ok(requests.some(entry => entry.role === 'child'), 'a real child request was admitted');
      assert.ok(!foreground.replies[0].content.includes(marker), 'no fabricated completion before the child can read');
      await sleep(3000);
      const waiting = await snapshot('waiting-with-child-not-yet-released');
      assert.equal(waiting.parentRequests, foreground.parentRequests, 'no model polling while waiting');
      assert.equal(waiting.replies.length, 1);
      phase = 'completion'; childGate.resolve();
    }
    await waitFor('async completion', state => tasks.list(sessionId)[0]?.status === 'completed' && !state.busy && !ordinaryActive && visible(state).length >= (ordinaryChat ? 1 : 2));
    const completed = await snapshot('async-completion-settled');
    if (!ordinaryChat) assert.equal(completed.replies.length, 2, 'one normal async completion reply');
    assert.equal(tasks.list(sessionId).length, 1, 'one child task');
    if (ordinaryChat) assert.ok(completed.taskNotices <= 1, 'foreground result consumption may suppress the async notice');
    else assert.equal(completed.taskNotices, 1, 'one delivered task completion');
    assert.equal(completed.replies.filter(reply => reply.content.includes(marker)).length, 1, 'one reply delivers the real verification code');
    assert.ok(completed.replies.at(-1).content.includes(String(expectedTotal)), 'completion contains the real arithmetic result');
    await sleep(8000);
    const quiet = await snapshot('quiet-after-completion');
    assert.equal(quiet.parentRequests, completed.parentRequests, 'no extra model request after completion');
    assert.equal(quiet.replies.length, completed.replies.length, 'no duplicate reply after completion');
    phase = 'followup';
    await turn('收到，不需要任何其他操作。只回复“好的”。');
    await waitFor('follow-up', state => !state.busy && !ordinaryActive && visible(state).length >= completed.replies.length + 1);
    await sleep(8000);
    const followup = await snapshot('followup-settled');
    assert.equal(followup.parentRequests, completed.parentRequests + 1, 'follow-up sends one request, without reawakening the consumed completion');
    assert.equal(followup.replies.length, completed.replies.length + 1);
    assert.equal(followup.taskNotices, completed.taskNotices, 'later user input does not redeliver a consumed completion');
    const parentExecutions = executions.filter(entry => entry.sessionId === sessionId);
    assert.equal(parentExecutions.filter(entry => entry.name === 'subagent').length, 1, 'dispatch executes once');
    if (!ordinaryChat) assert.equal(parentExecutions.filter(entry => entry.name === 'tasks').length, 0, 'Assistant does not poll tasks');
    const loads = parentExecutions.filter(entry => entry.name === 'get_tool_schema');
    assert.equal(loads.length, advanced ? 1 : 0, 'only advanced configuration loads the schema');
    const wrapped = parents().flatMap(entry => entry.tools).filter(call => call.name === 'call_tool');
    assert.ok(advanced ? wrapped.length >= 1 : wrapped.length === 0, 'advanced invocation uses the existing wrapper');
    if (advanced) {
      const dispatch = parentExecutions.find(entry => entry.name === 'subagent');
      assert.equal(dispatch.input.mode, 'clean');
      assert.ok(dispatch.input.systemPrompt, 'the omitted configuration survives invocation');
      assert.ok(loads[0].finishedAt <= dispatch.startedAt, 'schema receipt precedes invocation');
    }
    assert.ok(executions.some(entry => entry.sessionId !== sessionId && entry.name === 'read_file' && entry.status === 'returned'), 'real child reads with the real file tool');
    assert.equal(await readFile(source, 'utf8'), sourceContent, 'read-only source stays unchanged');
    await Promise.all(ordinaryRuns);
    const history = ordinaryChat ? sessions.snapshot(sessionId).turns.flatMap(turn => turn.messages.map(record => record.message))
      : new ConversationJournal(join(dataRoot, 'conversation-journal')).modelHistory(sessionId).read().messages;
    if (ordinaryChat) assert.deepEqual(history.filter(message => message.role === 'assistant' && !message.toolCalls.length && message.content.trim()).map(message => message.content),
      parents().filter(request => !request.tools.length && request.text.trim()).map(request => request.text), 'all observed ordinary replies are committed once');
    const calls = history.flatMap(message => message.role === 'assistant' ? message.toolCalls : []);
    const receipts = history.filter(message => message.role === 'tool');
    result.toolFailures = receipts.flatMap(message => {
      let value; try { value = JSON.parse(message.content); } catch { return []; }
      const failure = value?.runtimeError ?? (value?.status === 'failed' ? value : undefined);
      return failure ? [{ toolCallId: message.toolCallId,
        name: calls.find(call => call.id === message.toolCallId)?.name, code: failure.code, error: failure.message ?? failure.error }] : [];
    });
    for (const call of calls) assert.equal(receipts.filter(message => message.toolCallId === call.id).length, 1, 'one receipt per model tool call');
    const completionMessages = history.filter(message => message.name === notificationName);
    const foregroundCompletions = receipts.filter(message => message.content.includes(marker) &&
      ['tasks', 'await'].includes(calls.find(call => call.id === message.toolCallId)?.name));
    result.resultDeliveries = { notification: completionMessages.length, foreground: foregroundCompletions.length };
    assert.equal(completionMessages.length + foregroundCompletions.length, 1, 'the complete child result is consumed exactly once');
    for (const group of ['foreground', 'completion', 'followup']) {
      const rounds = parents().filter(entry => entry.phase === group);
      const finalCount = rounds.filter(entry => !entry.tools.length).length;
      if (ordinaryChat && (group === 'foreground' || !rounds.length)) assert.ok(finalCount <= 1, 'ordinary result may be consumed in the foreground');
      else assert.equal(finalCount, 1, `${group}: one final response round`);
      assert.ok(rounds.every(entry => !entry.failures.length), 'no hidden retry of a failed request');
    }
    await Promise.all(captures);
    for (const request of requests) {
      const sent = http.filter(entry => entry.requestNumber === request.number);
      assert.equal(sent.length, 1, `request ${request.number}: one HTTP dispatch, no transport retry/fallback`);
      assert.equal(sent[0].status, 200);
    }
    const inferenceHttp = http.filter(entry => entry.requestNumber !== undefined);
    assert.equal(new Set(inferenceHttp.map(entry => entry.bodyHash)).size, inferenceHttp.length, 'no identical inference request body is submitted twice');
    result.runtimeChecksPassed = true;
    result.success = result.toolFailures.length === 0;
    if (!result.success) result.failure = 'Runtime delivery checks passed, but model-generated tool arguments required correction; extra model rounds were necessary.';
  } catch (error) { result.failure = scrub(error.stack ?? error.message); }
  finally {
    result.finalSnapshot = await read();
    if (ordinaryChat) result.sessionSnapshot = sessions.snapshot(sessionId);
    result.tasks = tasks.list(sessionId);
    result.counts = { parentForeground: parents().filter(entry => entry.phase === 'foreground').length,
      parentCompletion: parents().filter(entry => entry.phase === 'completion').length,
      parentFollowup: parents().filter(entry => entry.phase === 'followup').length,
      child: requests.filter(entry => entry.role === 'child').length,
      inferenceHttp: http.filter(entry => entry.requestNumber !== undefined).length,
      auxiliaryHttp: http.filter(entry => entry.requestNumber === undefined).map(entry => ({ path: entry.path, status: entry.status })),
      summaryForUser: executions.filter(entry => entry.sessionId === sessionId && entry.name === 'summary_for_user').length,
      toolFailures: result.toolFailures?.length,
      taskNotices: result.finalSnapshot.entries.filter(entry => entry.source === 'task').length,
      visibleReplies: visible(result.finalSnapshot).length };
    const turns = new Map(requests.map(entry => [JSON.stringify([entry.sessionId, entry.turnId]), entry]));
    result.runtimeEvents = [...turns.values()].flatMap(entry => host.events(entry.sessionId, entry.turnId));
    result.childToolFailures = result.runtimeEvents.filter(event => event.sessionId !== sessionId && event.kind === 'tool_failed').map(event => ({
      toolCallId: event.payload.toolCallId, name: event.payload.toolName,
      code: event.payload.error?.code, error: event.payload.error?.message,
    }));
    if (result.childToolFailures.length) {
      result.success = false;
      result.failure = [result.failure, 'A child tool call was rejected and required model correction.'].filter(Boolean).join(' ');
    }
    if (!ordinaryChat) await command({ action: 'stop' }).catch(() => {});
    childGate.resolve();
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    await Promise.allSettled(captures);
    await save(join(directory, 'verification.json'), result);
    log({ scenario: name, success: result.success, failure: result.failure, counts: result.counts, reportPath: join(directory, 'verification.json') });
  }
  return result;
}

const cases = [['ordinary', false, false], ['on-demand', true, false], ['chat-ordinary', false, true], ['chat-on-demand', true, true]];
const namedCases = process.argv.find(value => value.startsWith('--cases='))?.slice(8).split(',');
if (namedCases) assert.ok(namedCases.length && namedCases.every(name => cases.some(item => item[0] === name)), 'Unknown live case.');
for (const [name, advanced, ordinaryChat] of cases) {
  if (namedCases ? !namedCases.includes(name) : ordinaryChat && !process.argv.includes('--with-ordinary-chat')) continue;
  report.scenarios.push(await scenario(name, advanced, ordinaryChat));
  await save(join(root, 'verification-progress.json'), report);
}
report.configUnchanged = digest(await readFile(configPath)) === digest(configBytes);
report.finishedAt = new Date().toISOString();
report.success = report.configUnchanged && report.scenarios.every(result => result.success);
await save(join(root, 'verification.json'), report);
log({ success: report.success, configUnchanged: report.configUnchanged, reportPath: join(root, 'verification.json') });
if (!report.success) process.exitCode = 1;
