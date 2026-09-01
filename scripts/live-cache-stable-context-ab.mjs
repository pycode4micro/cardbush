import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createProductAgentTurnRequest,
} from '@cardbush/bush-product-agent';
import { createLegacyProductAgentTurnRequest } from './cache-stable-legacy-baseline.mjs';
import { GET_RUNTIME_SESSION_COMMAND } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { OpenAIResponsesProviderRegistry } from '@cardbush/bush-provider-openai';

const configPath = resolve(
  process.env.BUSH_LIVE_MODEL_CONFIG_PATH ||
    join(process.env.APPDATA || '', 'cardbush', 'product-host', 'config', 'models.json'),
);
const imagePath = requiredAbsolute(process.env.BUSH_LIVE_CACHE_IMAGE, 'BUSH_LIVE_CACHE_IMAGE');
const probeOnly = process.env.BUSH_LIVE_CACHE_MODE === 'probe';
const extendedOnly = process.env.BUSH_LIVE_CACHE_MODE === 'extended';
const includeImage = process.env.BUSH_LIVE_CACHE_WITH_IMAGE !== '0';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const models = Array.isArray(config.models) ? config.models : [];
const requestedModelId = String(process.env.BUSH_LIVE_MODEL_ID ?? '').trim();
const selected = models.find((item) => String(item.id ?? '') === requestedModelId)
  ?? models.find((item) => String(item.id ?? '') === String(config.defaultModelId ?? config.default_model_id ?? ''))
  ?? models[0];
if (!selected) throw new Error('No live model configuration was found.');
const apiKey = stringValue(selected.apiKey ?? selected.api_key);
const model = stringValue(selected.model ?? selected.modelName ?? selected.model_name);
const baseURL = stringValue(selected.baseURL ?? selected.baseUrl ?? selected.base_url);
if (!apiKey || !model) throw new Error('The selected live model configuration is incomplete.');

const providers = new OpenAIResponsesProviderRegistry();
const configured = providers.upsert({
  protocol: 'bush.provider_binding_config.v1',
  bindingId: stringValue(selected.id) || model,
  adapter: 'openai_responses',
  apiKey,
  baseURL: baseURL || undefined,
  defaultHeaders: {},
});
if (configured.status !== 'configured' || !configured.binding) {
  throw new Error('Provider binding was not configured.');
}

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const reportRoot = join(tmpdir(), `cardbush-cache-stable-real-ab-${runId}`);
await mkdir(reportRoot, { recursive: true });
const commonReference = Array.from({ length: 260 }, (_, index) =>
  `Reference ${String(index + 1).padStart(3, '0')}: cache validation context is inert; preserve exact ordering and answer only the requested acknowledgement.`,
).join('\n');
const branches = [];
const branchDefinitions = [
  { name: 'baseline', createRequest: createLegacyProductAgentTurnRequest },
  { name: 'cache_stable_bypass', createRequest: createProductAgentTurnRequest },
];
const orderedBranches = process.env.BUSH_LIVE_CACHE_ORDER === 'reverse'
  ? [...branchDefinitions].reverse()
  : branchDefinitions;
const requestedBranch = String(process.env.BUSH_LIVE_CACHE_BRANCH ?? '').trim();
const selectedBranches = requestedBranch
  ? orderedBranches.filter((branch) => branch.name === requestedBranch)
  : probeOnly ? orderedBranches.slice(0, 1) : orderedBranches;
if (selectedBranches.length === 0) {
  throw new Error(`Unknown BUSH_LIVE_CACHE_BRANCH: ${requestedBranch}`);
}
for (const branch of selectedBranches) {
  branches.push(await runBranch(branch));
}

const report = {
  protocol: 'cardbush.cache_stable_real_api_ab.v1',
  createdAt: new Date().toISOString(),
  model: {
    id: stringValue(selected.id),
    provider: stringValue(selected.provider),
    model,
    baseURL,
  },
  imagePath,
  branches,
  comparison: compareBranches(branches),
};
const reportPath = join(reportRoot, 'report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ reportPath, ...report.comparison }, null, 2)}\n`);

async function runBranch(branch) {
  const host = new InMemoryRuntimeHost({
    provider: providers,
    toolRegistry: new ToolRegistry(),
    maxAttempts: 1,
    hostId: `cache-stable-real-ab-${branch.name}`,
  });
  const sessionId = `cache-stable-real-ab-${branch.name}-${crypto.randomUUID()}`;
  const projectInstructions = [
    `Cache A/B branch identity: ${branch.name}-${crypto.randomUUID()}`,
    commonReference,
  ].join('\n');
  const allTurnInputs = [
    { text: 'Cache validation step one. Reply with exactly ACK-1.', images: [] },
    {
      text: includeImage
        ? 'Cache validation step two. Inspect the attached image and reply with exactly ACK-2.'
        : 'Cache validation step two. Reply with exactly ACK-2.',
      images: includeImage ? [imagePath] : [],
    },
    { text: 'Cache validation step three. Reply with exactly ACK-3.', images: [] },
  ];
  const extendedTurnInputs = [
    ...allTurnInputs,
    ...Array.from({ length: 4 }, (_, offset) => {
      const step = offset + 4;
      const deterministicTail = Array.from({ length: 260 }, (__, index) =>
        `tail-${step}-${String(index + 1).padStart(3, '0')}`,
      ).join(' ');
      return {
        text: `Cache validation step ${step}. ${deterministicTail}. Reply with exactly ACK-${step}.`,
        images: [],
      };
    }),
  ];
  const turnInputs = probeOnly
    ? allTurnInputs.slice(0, 1)
    : extendedOnly ? extendedTurnInputs : allTurnInputs;
  const turns = [];
  let sessionEnvironmentLocalDate;
  for (let index = 0; index < turnInputs.length; index += 1) {
    const turnInput = turnInputs[index];
    const turnId = `turn-${index + 1}-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const localDate = new Date().toLocaleDateString('en-CA');
    const request = branch.createRequest({
      requestId: `request-${crypto.randomUUID()}`,
      sessionId,
      turnId,
      messageId: `message-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      localDate,
      ...(branch.name === 'cache_stable_bypass'
        ? { sessionEnvironmentLocalDate }
        : {}),
      userText: turnInput.text,
      model,
      providerBinding: configured.binding,
      tools: [],
      projectDir: process.cwd(),
      workspaceDir: process.cwd(),
      projectInstructions,
      images: turnInput.images,
      filesystemLocations: [
        { id: 'desktop', name: 'Desktop', path: join(process.env.USERPROFILE || '', 'Desktop') },
      ],
      permissionMode: 'all_free',
      planEnabled: false,
      visionEnabled: true,
      maxOutputTokens: 32,
      reasoningEffort: 'none',
    });
    const terminal = await host.runSessionTurn(request);
    const snapshot = await host.sendCommand({
      kind: GET_RUNTIME_SESSION_COMMAND,
      payload: { sessionId },
    });
    const committed = snapshot?.turns.find((turn) => turn.turnId === turnId);
    const events = host.events(sessionId, turnId);
    const cacheObservation = events.find((event) => event.kind === 'cache_chain_observed');
    const finalMessage = committed?.messages.find(
      (message) => message.messageId === terminal.payload.finalMessageId,
    );
    const usage = committed?.usage ?? {};
    if (branch.name === 'cache_stable_bypass') {
      sessionEnvironmentLocalDate = localDate;
    }
    turns.push({
      turn: index + 1,
      turnId,
      durationMs: Date.now() - startedAt,
      terminal: terminal.payload,
      images: turnInput.images.length,
      inputTokens: usage.inputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      uncachedInputTokens: typeof usage.inputTokens === 'number'
        ? usage.inputTokens - (usage.cachedInputTokens ?? 0)
        : null,
      cacheHitPercent: typeof usage.inputTokens === 'number' && usage.inputTokens > 0
        ? Number((100 * (usage.cachedInputTokens ?? 0) / usage.inputTokens).toFixed(2))
        : null,
      cacheChain: cacheObservation?.payload ?? null,
      providerRetries: events.filter((event) => event.kind === 'provider_retry').length,
      response: finalMessage?.message.role === 'assistant'
        ? finalMessage.message.content
        : '',
    });
  }
  return {
    name: branch.name,
    sessionId,
    turns,
    totalInputTokens: sum(turns, 'inputTokens'),
    totalCachedInputTokens: sum(turns, 'cachedInputTokens'),
    totalUncachedInputTokens: sum(turns, 'uncachedInputTokens'),
    aggregateCacheHitPercent: percentage(
      sum(turns, 'cachedInputTokens'),
      sum(turns, 'inputTokens'),
    ),
    frozenPrefixBreaks: turns.filter((turn) => turn.cacheChain?.frozenPrefixBreak).length,
    totalDurationMs: sum(turns, 'durationMs'),
  };
}

function compareBranches(results) {
  const baseline = results.find((branch) => branch.name === 'baseline');
  const bypass = results.find((branch) => branch.name === 'cache_stable_bypass');
  return {
    baseline: summarize(baseline),
    bypass: summarize(bypass),
    uncachedInputTokenReduction: baseline && bypass
      ? baseline.totalUncachedInputTokens - bypass.totalUncachedInputTokens
      : null,
    uncachedInputReductionPercent: baseline && bypass
      ? percentage(
        baseline.totalUncachedInputTokens - bypass.totalUncachedInputTokens,
        baseline.totalUncachedInputTokens,
      )
      : null,
    durationReductionMs: baseline && bypass
      ? baseline.totalDurationMs - bypass.totalDurationMs
      : null,
  };
}

function summarize(branch) {
  return branch ? {
    aggregateCacheHitPercent: branch.aggregateCacheHitPercent,
    totalInputTokens: branch.totalInputTokens,
    totalCachedInputTokens: branch.totalCachedInputTokens,
    totalUncachedInputTokens: branch.totalUncachedInputTokens,
    frozenPrefixBreaks: branch.frozenPrefixBreaks,
    totalDurationMs: branch.totalDurationMs,
    turns: branch.turns.map((turn) => ({
      turn: turn.turn,
      images: turn.images,
      cacheHitPercent: turn.cacheHitPercent,
      uncachedInputTokens: turn.uncachedInputTokens,
      frozenPrefixBreak: turn.cacheChain?.frozenPrefixBreak ?? null,
      breakIndex: turn.cacheChain?.breakIndex ?? null,
      durationMs: turn.durationMs,
      terminalStatus: turn.terminal.status,
      response: turn.response,
    })),
  } : null;
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function percentage(part, total) {
  return total > 0 ? Number((100 * part / total).toFixed(2)) : null;
}

function requiredAbsolute(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !isAbsolute(normalized)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(normalized);
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}
