import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GET_RUNTIME_SESSION_COMMAND, GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND, LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND, reasoningEffortSchema } from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest, ROOT_AGENT_SYSTEM_PROMPT } from '@cardbush/bush-product-agent';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { OpenAIResponsesProviderRegistry } from '@cardbush/bush-provider-openai';
import { benchmarkTools } from './suite.mjs';
import { containedPath, projectRoot } from './harness.mjs';

export async function configure(values) {
  let apiKey = process.env.OPENAI_API_KEY;
  let model = values.model ?? process.env.BUSH_LIVE_MODEL;
  let baseURL = process.env.OPENAI_BASE_URL;
  let defaultHeaders = {};
  const configPath = values.config ?? process.env.BUSH_LIVE_MODEL_CONFIG_PATH;
  if (configPath) {
    const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
    const id = values['model-id'] ?? process.env.BUSH_LIVE_MODEL_ID ?? config.default_model_id ?? config.defaultModelId;
    const selected = (config.models ?? []).find(item => String(item.id) === String(id));
    if (!selected) throw new Error('No matching model configuration. Supply --model-id or configure a default model.');
    apiKey = selected.api_key ?? selected.apiKey;
    model ??= selected.model_name ?? selected.modelName ?? selected.model;
    baseURL = selected.baseURL ?? selected.base_url ?? selected.baseUrl;
    defaultHeaders = selected.defaultHeaders ?? selected.default_headers ?? {};
  }
  if (!apiKey?.trim() || !model?.trim()) {
    throw new Error('Live evaluation needs --config <path> (with --model-id if needed), or OPENAI_API_KEY and --model. Do not put keys in command arguments.');
  }
  const bounds = {
    maxRounds: positiveInteger(values['max-rounds'], '--max-rounds'),
    timeoutMs: positiveInteger(values['timeout-ms'], '--timeout-ms'),
    tokenStop: positiveInteger(values['token-stop'], '--token-stop'),
  };
  const maxOutputTokens = positiveInteger(values['max-output-tokens'] ?? '4096', '--max-output-tokens');
  if (maxOutputTokens >= 100_000) throw new Error('--max-output-tokens must be smaller than the benchmark context window (100000).');
  reasoningEffortSchema.parse(values.reasoning);
  const providers = new OpenAIResponsesProviderRegistry();
  const configured = providers.upsert({
    protocol: 'bush.provider_binding_config.v1', bindingId: 'coding-benchmark', adapter: 'openai_responses',
    apiKey: apiKey.trim(), baseURL: baseURL?.trim() || undefined, defaultHeaders,
  });
  if (!configured.binding) throw new Error('Provider binding could not be configured.');
  const runtimeHashes = {};
  for (const path of [
    'packages/bush-protocol/src/model.ts', 'packages/bush-protocol/src/tool.ts', 'packages/bush-runtime/src/modelRound.ts',
    'packages/bush-runtime/src/inMemoryRuntimeHost.ts', 'packages/bush-runtime/src/workspaceTools.ts',
    'packages/bush-runtime/src/workspaceFileRead.ts', 'packages/bush-runtime/src/modelReplay.ts',
    'packages/bush-runtime/src/contextCompaction.ts',
    'packages/bush-runtime/src/runtimeToolLoop.ts',
    'packages/bush-runtime/src/toolRegistry.ts', 'packages/bush-runtime/src/toolResultText.ts',
    'packages/bush-runtime/src/toolExecutionStore.ts',
    'packages/bush-runtime/src/extendedBuiltins.ts',
    'packages/bush-provider-openai/src/responses.ts', 'packages/bush-provider-openai/src/responsesReplay.ts',
  ]) {
    try { runtimeHashes[path] = hash((await readFile(join(projectRoot, path), 'utf8')).replaceAll('\r\n', '\n')); }
    catch (error) { if (error.code === 'ENOENT') runtimeHashes[path] = null; else throw error; }
  }
  return {
    providers, binding: configured.binding, model: model.trim(), reasoning: values.reasoning, maxOutputTokens, ...bounds,
    publicConfig: { model: model.trim(), adapter: 'openai_responses', reasoning: values.reasoning,
      ...bounds, maxOutputTokens, maxContextTokens: 100_000, runtimeHashes,
      rootPromptHash: hash(ROOT_AGENT_SYSTEM_PROMPT), driverHash: hash(await readFile(new URL('./live.mjs', import.meta.url))),
      permissionMode: 'task_free', tools: [...benchmarkTools],
      tokenStopPolicy: 'Stop before a new request once reported cumulative input + output reaches the threshold; one response can cross it. Missing usage cannot enforce this threshold.',
    },
  };
}

export async function runTask(task, workspace, dataRoot, config) {
  const started = Date.now();
  // Keep diagnostic evidence outside the candidate workspace. Only model-facing
  // messages and execution facts are copied, never provider configuration,
  // credentials, transport errors, or hidden reasoning/replay payloads.
  const trace = {
    protocol: 'cardbush.coding_benchmark_trace.v1', taskId: task.id,
    requests: [], sourceSnapshots: {},
  };
  const control = new AbortController();
  const observer = new AbortController();
  let stopReason = null, requests = 0, reportedTokens = 0, usageMissingRequests = 0;
  const stop = reason => { stopReason ??= reason; control.abort(); };
  const budgetAvailable = () => {
    if (requests >= config.maxRounds) stop('request_limit');
    if (reportedTokens >= config.tokenStop) stop('reported_token_threshold');
    control.signal.throwIfAborted();
  };
  const provider = {
    countInputTokens(request, options) { budgetAvailable(); return config.providers.countInputTokens(request, options); },
    async *stream(request, options) {
      budgetAvailable();
      requests += 1;
      const round = {
        request: requests, requestId: request.requestId, startedAt: new Date().toISOString(),
        messages: request.messages.map(({ role, content, name, toolCallId, toolCalls }) =>
          ({ role, content, name, toolCallId, toolCalls })),
        maxOutputTokens: request.maxOutputTokens, reasoningEffort: request.reasoningEffort,
        sourceRevisions: {}, outputToolCalls: [], textChars: 0, reasoningChars: 0,
      };
      trace.requests.push(round);
      for (const path of task.files ?? []) {
        try {
          const bytes = await readFile(containedPath(workspace, path));
          const revision = hash(bytes);
          round.sourceRevisions[path] = revision;
          trace.sourceSnapshots[revision] ??= bytes.toString('utf8');
        } catch (error) {
          (round.sourceReadErrors ??= {})[path] = error.code ?? error.name ?? 'Error';
        }
      }
      const requestStarted = Date.now();
      let usage;
      try {
        for await (const event of config.providers.stream(request, options)) {
          if (event.kind === 'usage') usage = event;
          if (event.kind === 'response_completed') round.finishReason = event.finishReason;
          if (event.kind === 'response_failed') round.failure = { code: event.code, status: event.status };
          if (event.kind === 'text_delta') round.textChars += event.delta.length;
          if (event.kind === 'reasoning_delta') round.reasoningChars += event.delta.length;
          if (event.kind === 'tool_call_delta') {
            const call = round.outputToolCalls[event.index] ??= { name: '', argumentsText: '' };
            if (event.toolCallId) call.id = event.toolCallId;
            call.name += event.nameDelta ?? '';
            call.argumentsText += event.argumentsDelta ?? '';
          }
          yield event;
        }
      } catch (error) {
        round.errorName = error instanceof Error ? error.name : 'UnknownError';
        throw error;
      } finally {
        if (usage?.inputTokens === undefined || usage.outputTokens === undefined) usageMissingRequests += 1;
        reportedTokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
        round.durationMs = Date.now() - requestStarted;
        round.usage = usage ? {
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
        } : null;
        round.cumulativeReportedTokens = reportedTokens;
      }
    },
  };
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry, maxAttempts: 1, dataRoot, hostId: 'coding-benchmark' });
  const catalog = await host.sendCommand({ kind: GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND, payload: {} });
  const sessionId = `benchmark-${randomUUID()}`, turnId = `turn-${randomUUID()}`;
  const request = createProductAgentTurnRequest({
    requestId: `request-${randomUUID()}`, sessionId, turnId, messageId: `message-${randomUUID()}`,
    createdAt: new Date().toISOString(), localDate: new Date().toISOString().slice(0, 10),
    userText: `${task.prompt}\n\n当前目录是独立评测副本。请阅读 TASK.md 并运行 npm test；可以添加回归测试，只在当前工作目录内工作。`,
    model: config.model, providerBinding: config.binding, tools: catalog.filter(entry => benchmarkTools.has(entry.definition.name)).map(entry => entry.definition),
    projectDir: workspace, workspaceDir: workspace, permissionMode: 'task_free', planEnabled: true,
    reasoningEffort: config.reasoning, maxOutputTokens: config.maxOutputTokens ?? 4096, maxContextTokens: 100_000, interactiveRequestsEnabled: false,
  });
  const watch = (async () => {
    try {
      for await (const event of host.openEventStream({ sessionId, turnId, signal: observer.signal })) {
        if (event.kind === 'permission_requested') stop('permission_required');
      }
    } catch (error) { if (!observer.signal.aborted) throw error; }
  })();
  // A monitoring failure must also settle the Turn, not leave a hidden waiter.
  const watched = watch.catch(() => { stop('observer_failed'); });
  const timer = setTimeout(() => stop('timeout'), config.timeoutMs);
  let terminal, errorName;
  try { terminal = await host.runSessionTurn(request, { signal: control.signal }); }
  catch (error) { errorName = error instanceof Error ? error.name : 'UnknownError'; }
  finally { clearTimeout(timer); observer.abort(); await watched; }
  const session = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId } });
  const records = await host.sendCommand({ kind: LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND, payload: { sessionId, turnId } });
  const events = host.events(sessionId, turnId);
  // These terminals belong to this benchmark's private host and Session only.
  // An agent may finish while a terminal is still alive, so settle it explicitly.
  const cleanup = { stoppedTerminals: 0, errors: [] };
  const terminals = await registry.resolve('terminal_list').execute({ sessionId });
  for (const terminal of terminals.sessions) {
    try {
      const registration = registry.resolve('terminal_stop');
      await registration.execute({ sessionId, input: registration.decodeInput({ session_id: terminal.terminalSessionId }) });
      if (terminal.state === 'running') cleanup.stoppedTerminals += 1;
    } catch (error) { cleanup.errors.push(error.code ?? error.name ?? 'Error'); }
  }
  const tracePath = join(dataRoot, 'diagnostic-trace.json');
  await mkdir(dataRoot, { recursive: true });
  await writeFile(tracePath, JSON.stringify({
    ...trace, toolExecutions: records, terminal: terminal?.payload, stopReason, errorName, cleanup,
    runtimeEvents: events.filter(event => event.kind === 'provider_retry' || event.kind.startsWith('context_compaction_')),
  }, null, 2) + '\n');
  return {
    durationMs: Date.now() - started, terminal: terminal?.payload.status ?? 'failed', errorName, stopReason,
    modelRequests: requests, reportedTokens, usageMissingRequests, usage: session?.turns.at(-1)?.usage ?? null,
    humanInterventions: 0, permissionRequests: events.filter(event => event.kind === 'permission_requested').length,
    toolCalls: records.length, toolFailures: records.filter(record => record.outcome === 'failed').length,
    tools: records.map(record => ({ round: record.round, name: record.toolCall.name, outcome: record.outcome, errorCode: record.error?.code })),
    cleanup, tracePath,
  };
}

function positiveInteger(value, name) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`${name} must be a positive integer.`);
  return numeric;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
