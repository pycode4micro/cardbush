import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import {
  GET_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
  LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
} from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import {
  InMemoryRuntimeHost,
  ToolRegistry,
} from '@cardbush/bush-runtime';
import { OpenAIResponsesProviderRegistry } from '@cardbush/bush-provider-openai';

const configPath = requiredAbsolute(process.env.BUSH_LIVE_MODEL_CONFIG_PATH, 'BUSH_LIVE_MODEL_CONFIG_PATH');
const sourceProject = requiredAbsolute(process.env.BUSH_LIVE_PROJECT, 'BUSH_LIVE_PROJECT');
const modelId = String(process.env.BUSH_LIVE_MODEL_ID ?? '').trim();
const task = String(process.env.BUSH_LIVE_TASK ?? '').trim() || [
  '为这个项目补上一套可重复的 War 对局转录功能。',
  'Python 和 Rust 两套实现都要把每回合抽到的牌、赢家和累计牌堆数量导出为稳定 JSON，',
  '并证明相同 seed 的两端结果逐项一致。请完成实现、自动测试和必要说明，最终给出验证结果。',
].join('');

const legacy = JSON.parse(await readFile(configPath, 'utf8'));
const configs = Array.isArray(legacy.models) ? legacy.models : [];
const selected = configs.find((item) => String(item.id ?? '') === modelId)
  ?? configs.find((item) => String(item.id ?? '') === String(legacy.default_model_id ?? legacy.defaultModelId ?? ''))
  ?? configs[0];
if (!selected) throw new Error('No model configuration was found.');
const apiKey = String(selected.api_key ?? selected.apiKey ?? '').trim();
const model = String(selected.model_name ?? selected.modelName ?? selected.model ?? '').trim();
const baseURL = String(selected.base_url ?? selected.baseUrl ?? '').trim();
if (!apiKey || !model) throw new Error('The selected model configuration is incomplete.');

const runRoot = join(
  tmpdir(),
  `cardbush-ts-live-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`,
);
const projectDir = join(runRoot, basename(sourceProject));
await mkdir(runRoot, { recursive: true });
await cp(sourceProject, projectDir, {
  recursive: true,
  filter: (source) => !excludedPath(source, sourceProject),
});

const providers = new OpenAIResponsesProviderRegistry();
const configured = providers.upsert({
  protocol: 'bush.provider_binding_config.v1',
  bindingId: String(selected.id ?? model),
  adapter: 'openai_responses',
  apiKey,
  baseURL: baseURL || undefined,
  defaultHeaders: {},
});
if (configured.status !== 'configured' || !configured.binding) {
  throw new Error('Provider binding was not configured.');
}
const host = new InMemoryRuntimeHost({
  provider: providers,
  toolRegistry: new ToolRegistry(),
  maxAttempts: 5,
  hostId: 'live-game-validation',
});
const catalog = await host.sendCommand({
  kind: GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
  payload: {},
});
const sessionId = `live-game-${crypto.randomUUID()}`;
const turnId = `turn-${crypto.randomUUID()}`;
const startedAt = Date.now();
const request = createProductAgentTurnRequest({
  requestId: `request-${crypto.randomUUID()}`,
  sessionId,
  turnId,
  messageId: `message-${crypto.randomUUID()}`,
  createdAt: new Date().toISOString(),
  localDate: new Date().toLocaleDateString('en-CA'),
  userText: task,
  model,
  providerBinding: configured.binding,
  tools: catalog.map((entry) => entry.definition),
  projectDir,
  permissionMode: 'all_free',
  planEnabled: true,
  reasoningEffort: 'high',
});

const terminal = await host.runSessionTurn(request);
const session = await host.sendCommand({
  kind: GET_RUNTIME_SESSION_COMMAND,
  payload: { sessionId },
});
const records = await host.sendCommand({
  kind: LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
  payload: { sessionId, turnId },
});
const events = host.events(sessionId, turnId);
const finalMessage = session?.turns
  .flatMap((turn) => turn.messages)
  .find((item) => item.messageId === terminal.payload.finalMessageId);
const usage = session?.turns.at(-1)?.usage ?? {};
const eventKindCounts = countBy(events, (event) => event.kind);
const toolNameCounts = countBy(records, (record) => record.toolCall.name);
const toolOutcomeCounts = countBy(records, (record) => record.outcome);
const toolErrorKindCounts = countBy(
  records.filter((record) => record.result.error),
  (record) => record.result.error.kind,
);
const toolErrorCodeCounts = countBy(
  records.filter((record) => record.result.error),
  (record) => record.result.error.code,
);
const facts = records.flatMap((record) => record.result.facts);
const factVerificationCounts = countBy(facts, (fact) => fact.verification_state);
const factSemanticCounts = countBy(facts, (fact) => String(fact.semantic_success));
const toolLatencies = toolLatencySamples(events);
const cacheHitRate = typeof usage.inputTokens === 'number' && usage.inputTokens > 0
  ? (usage.cachedInputTokens ?? 0) / usage.inputTokens
  : null;
const consistencyViolations = records.flatMap((record) => inspectToolRecord(record));
const report = {
  protocol: 'cardbush.live_runtime_validation.v1',
  model: { provider: String(selected.provider ?? ''), model },
  sourceProject,
  projectDir,
  sessionId,
  turnId,
  durationMs: Date.now() - startedAt,
  terminal: terminal.payload,
  usage,
  cache: {
    hitRate: cacheHitRate,
    hitPercent: cacheHitRate === null ? null : cacheHitRate * 100,
    uncachedInputTokens: typeof usage.inputTokens === 'number'
      ? usage.inputTokens - (usage.cachedInputTokens ?? 0)
      : null,
  },
  eventCount: events.length,
  eventKindCounts,
  providerRetryCount: events.filter((event) => event.kind === 'provider_retry').length,
  rounds: records.reduce((maximum, record) => Math.max(maximum, record.round), 0),
  toolNameCounts,
  toolOutcomeCounts,
  toolErrorKindCounts,
  toolErrorCodeCounts,
  facts: {
    count: facts.length,
    verificationCounts: factVerificationCounts,
    semanticSuccessCounts: factSemanticCounts,
  },
  toolLatencyMs: summarizeLatencies(toolLatencies),
  consistency: {
    violationCount: consistencyViolations.length,
    violations: consistencyViolations,
  },
  tools: records.map((record) => ({
    round: record.round,
    name: record.toolCall.name,
    outcome: record.outcome,
    success: record.result.success,
    errorKind: record.result.error?.kind,
    errorCode: record.result.error?.code,
    errorMessage: record.result.error?.message,
    factCount: record.result.facts.length,
    verificationStates: [...new Set(record.result.facts.map((fact) => fact.verification_state))],
  })),
  finalResponse: finalMessage?.message.role === 'assistant'
    ? finalMessage.message.content
    : '',
};
const reportPath = join(runRoot, 'report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  reportPath,
  projectDir,
  durationMs: report.durationMs,
  terminal: report.terminal,
  usage: report.usage,
  eventCount: report.eventCount,
  providerRetryCount: report.providerRetryCount,
  toolCount: report.tools.length,
  toolFailures: report.tools.filter((item) => !item.success).length,
  cacheHitPercent: report.cache.hitPercent,
  consistencyViolationCount: report.consistency.violationCount,
  toolLatencyMs: report.toolLatencyMs,
})}\n`);

function requiredAbsolute(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !isAbsolute(normalized)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(normalized);
}

function excludedPath(candidate, root) {
  const relative = candidate.slice(root.length).replaceAll('\\', '/');
  return /(?:^|\/)(?:\.git|\.ruff_cache|__pycache__|target)(?:\/|$)/.test(relative);
}

function countBy(values, keyFor) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      const key = String(keyFor(value));
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function toolLatencySamples(events) {
  const startedAtByCall = new Map();
  const samples = [];
  for (const event of events) {
    const toolCallId = event.payload?.toolCallId;
    if (!toolCallId) continue;
    if (event.kind === 'tool_running') {
      startedAtByCall.set(toolCallId, Date.parse(event.createdAt));
      continue;
    }
    if (!['tool_completed', 'tool_failed', 'tool_cancelled'].includes(event.kind)) continue;
    const startedAt = startedAtByCall.get(toolCallId);
    const completedAt = Date.parse(event.createdAt);
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
      samples.push(completedAt - startedAt);
    }
  }
  return samples;
}

function summarizeLatencies(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}

function inspectToolRecord(record) {
  const violations = [];
  const reference = `${record.round}:${record.toolCall.name}:${record.toolCall.id}`;
  if (record.result.success !== (record.outcome === 'completed')) {
    violations.push({ reference, code: 'outcome_success_mismatch' });
  }
  if (record.result.success && record.result.error) {
    violations.push({ reference, code: 'successful_result_has_error' });
  }
  if (!record.result.success && !record.result.error) {
    violations.push({ reference, code: 'failed_result_missing_error' });
  }
  for (const fact of record.result.facts) {
    if (fact.semantic_success === true && !fact.execution_success) {
      violations.push({ reference, receiptId: fact.receipt_id, code: 'semantic_success_without_execution' });
    }
    if (fact.verification_state === 'verified' && fact.semantic_success !== true) {
      violations.push({ reference, receiptId: fact.receipt_id, code: 'verified_without_semantic_success' });
    }
    if (fact.error_code && fact.semantic_success === true) {
      violations.push({ reference, receiptId: fact.receipt_id, code: 'semantic_success_with_error' });
    }
  }
  return violations;
}
