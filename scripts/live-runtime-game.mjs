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
const report = {
  protocol: 'cardbush.live_runtime_validation.v1',
  model: { provider: String(selected.provider ?? ''), model },
  sourceProject,
  projectDir,
  sessionId,
  turnId,
  durationMs: Date.now() - startedAt,
  terminal: terminal.payload,
  usage: session?.turns.at(-1)?.usage ?? {},
  eventCount: events.length,
  providerRetryCount: events.filter((event) => event.kind === 'provider_retry').length,
  tools: records.map((record) => ({
    name: record.toolCall.name,
    outcome: record.outcome,
    success: record.result.success,
    errorCode: record.result.error?.code,
    errorMessage: record.result.error?.message,
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
