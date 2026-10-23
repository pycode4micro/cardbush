// Offline accounting only. Never contacts a model or reads credentials.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { CacheChainTracker } from '../packages/bush-runtime/dist/cacheChainTracker.js';

const { values } = parseArgs({ options: {
  directory: { type: 'string' }, output: { type: 'string' },
  'cache-price': { type: 'string', default: '0.04' },
  'input-price': { type: 'string', default: '2' },
  'output-price': { type: 'string', default: '8' },
} });
assert.ok(values.directory && values.output, 'Use --directory <completed-run> --output <new-json>');
const directory = resolve(values.directory);
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
assert.ok(report.completedAt && !report.failure && !report.failures?.length, 'A complete primary comparison is required.');
const rates = { cachedInput: Number(values['cache-price']), uncachedInput: Number(values['input-price']), output: Number(values['output-price']) };
assert.ok(Object.values(rates).every(price => Number.isFinite(price) && price >= 0));
assert.equal(new Set(report.requests.map(r => r.id)).size, report.requests.length, 'Count each request once.');
for (const r of report.requests) {
  assert.ok(['inputTokens', 'cachedInputTokens', 'outputTokens'].every(k => Number.isSafeInteger(r.usage?.[k]) && r.usage[k] >= 0), `Incomplete usage: ${r.id}`);
  assert.ok(r.usage.cachedInputTokens <= r.usage.inputTokens);
}
const sum = (rows, field) => rows.reduce((total, r) => total + r.usage[field], 0);
const round = value => Number(value.toFixed(8));
const charge = (cached, uncached, output) => round((cached * rates.cachedInput + uncached * rates.uncachedInput + output * rates.output) / 1e6);
const aggregate = rows => {
  const input = sum(rows, 'inputTokens'), cached = sum(rows, 'cachedInputTokens'), output = sum(rows, 'outputTokens');
  return { requests: rows.length, inputTokens: input, cachedInputTokens: cached, uncachedInputTokens: input - cached,
    outputTokens: output, totalTokens: input + output, inputCacheHitRate: input ? cached / input : null,
    cost: { cachedInput: charge(cached, 0, 0), uncachedInput: charge(0, input - cached, 0), output: charge(0, 0, output),
      total: charge(cached, input - cached, output) } };
};
const category = r => r.stage.endsWith('-audit') ? 'audit' : r.stage.includes('-prepare-') ? 'prepare' : r.maintenance ? 'maintenance' : 'continuation';
const analysis = {
  version: 1, createdAt: new Date().toISOString(), model: report.config.model,
  experiment: { startedAt: report.startedAt, completedAt: report.completedAt, modelRequests: report.requests.length,
    nowSentModelRequests: 0 },
  pricing: { currency: 'CNY', unit: 'per 1,000,000 tokens', rates,
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', checkedOn: '2026-10-23',
    basis: 'Public peak list-price estimate, not an account invoice. The recorded run was Friday 15:10–15:21 Asia/Shanghai. Off-peak prices are half.' },
  formula: '(inputTokens - cachedInputTokens) * uncachedInputPrice + cachedInputTokens * cachePrice + outputTokens * outputPrice, divided by 1e6',
  hitRateMethod: 'sum(cachedInputTokens) / sum(inputTokens); not an unweighted average of per-request ratios',
  cacheChainMethod: 'Replay saved visible request JSON through CacheChainTracker. Hidden reasoning and providerReplay were omitted when saved; this cannot reconstruct original provider wire prefixes or cache_chain_observed events. These diagnostics never replace actual provider usage.',
  variants: [],
};
for (const variant of ['baseline', 'prepared']) {
  const rows = report.requests.filter(r => r.stage.includes(`-${variant}-`));
  const noAudit = rows.filter(r => category(r) !== 'audit');
  const tracker = new CacheChainTracker(), chain = [];
  for (const r of noAudit) {
    assert.match(r.id, /^\d{3}-[a-z\d-]+$/);
    const request = JSON.parse(await readFile(join(directory, `${r.id}-request.json`), 'utf8'));
    assert.equal(createHash('sha256').update(JSON.stringify(request.tools)).digest('hex'), r.toolHash, 'Saved tool schema must match the recorded request.');
    const observation = tracker.observe(request);
    chain.push({ id: r.id, category: category(r), usage: r.usage,
      inputCacheHitRate: r.usage.cachedInputTokens / r.usage.inputTokens,
      projectionOnly: { previousMessageCount: observation.previousMessageCount, messageCount: observation.messageCount,
        sharedPrefixMessages: observation.sharedPrefixMessages, prefixComparisonAvailable: observation.prefixComparisonAvailable,
        frozenPrefixBreak: observation.frozenPrefixBreak, changedParameters: observation.changedParameters,
        ...(observation.breakIndex === undefined ? {} : { breakIndex: observation.breakIndex }) } });
  }
  const comparable = chain.filter(r => r.projectionOnly.prefixComparisonAvailable);
  analysis.variants.push({ variant, all: aggregate(rows), excludingAudits: aggregate(noAudit),
    categories: ['prepare', 'maintenance', 'continuation', 'audit'].map(stage => ({ stage, ...aggregate(rows.filter(r => category(r) === stage)) })),
    phases: [1, 2, 3, 4].map(p => ({ phase: `p${p}`, ...aggregate(noAudit.filter(r => r.stage.startsWith(`p${p}-`))) })),
    visibleChainSummary: { comparableTransitions: comparable.length,
      prefixBreaks: comparable.filter(r => r.projectionOnly.frozenPrefixBreak).length,
      parameterChanges: comparable.filter(r => r.projectionOnly.changedParameters.length).length,
      pressureTimeToolHashes: [...new Set(rows.filter(r => r.stage.endsWith('-boundary')).map(r => r.toolHash))] },
    chain,
  });
}
const [old, next] = analysis.variants.map(v => v.excludingAudits);
analysis.comparison = {
  costSaving: round(old.cost.total - next.cost.total), relativeCostReduction: 1 - next.cost.total / old.cost.total,
  totalTokenReduction: 1 - next.totalTokens / old.totalTokens,
  cachedInputReduction: 1 - next.cachedInputTokens / old.cachedInputTokens,
  uncachedInputReduction: 1 - next.uncachedInputTokens / old.uncachedInputTokens,
  cacheHitRateIncreasePercentagePoints: 100 * (next.inputCacheHitRate - old.inputCacheHitRate),
  allThreeBilledCategoriesLower: ['cachedInputTokens', 'uncachedInputTokens', 'outputTokens'].every(k => next[k] < old[k]),
  allMissSensitivity: { baselineCost: charge(0, old.inputTokens, old.outputTokens), preparedCost: charge(0, next.inputTokens, next.outputTokens),
    note: 'Hypothetical repricing of the recorded token volumes, not a new cold-cache experiment.' },
};
analysis.limitations = [
  'One continuous synthetic long-conversation sample per variant; does not establish universal cache behavior.',
  'Earlier debug requests, audit requests, shared prefixes and raw controls can warm the provider cache. Removing audit charges does not remove their cache effects.',
  'Preparation and boundary phases use different frozen test tool catalogs. Their observed tool changes are not evidence of dynamic top-level schema rewriting in production.',
  'Visible prefix breaks are expected at compression boundaries, source changes and disposable probe instructions; they do not mean zero cache hits.',
  'The comparison covers only requests recorded in this experiment. Synthetic business tool executions and identical fixed final prose were not billed; no production account invoice was queried.',
  'Preparing summaries adds upfront output cost; conversations that never require compaction may not recover this cost.',
  'Prices are explicit parameters. The default rates are the checked DeepSeek Flash peak CNY list prices.',
];
await writeFile(resolve(values.output), JSON.stringify(analysis, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ variants: analysis.variants.map(({ chain, ...v }) => v), comparison: analysis.comparison }, null, 2));
