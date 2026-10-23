// Read saved evidence only; never sends a model request or changes raw reports.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' } } });
assert.ok(values.output && positionals.length, 'Use --output <new-json-file> <run-directory> [run-directory...]');
const analysis = { version: 1, createdAt: new Date().toISOString(),
  measurement: 'Post-compaction actual provider input tokens include cached tokens; JSON/4 estimates are not used in these tables.',
  grading: 'Strict original field checks are preserved. Semantic scores additionally accept explicitly listed representational equivalents, never missing/nonmatching facts. Every conversion is recorded. controlMatched reports only fields the uncompressed control answered correctly, to avoid automatically blaming compression for shared answer/grading issues.',
  runs: [] };
const sum = (items, fn) => items.reduce((n, x) => n + (fn(x) ?? 0), 0);
const score = checks => ({ passed: checks.filter(c => c.passed).length, total: checks.length });
function semantic(check, all) {
  if (check.passed) return check;
  const { key, expected, actual } = check;
  let equivalent;
  if (Array.isArray(expected) && !expected.length && actual === null) equivalent = 'No recorded entries: null and empty list.';
  if (expected === null && Array.isArray(actual) && !actual.length) equivalent = 'Unknown scalar was returned as an empty list; no value was asserted.';
  if (key === 'opening_full_body_seconds' && Array.isArray(actual) && actual.length === 2 &&
    actual.every(Number.isFinite) && actual[1] - actual[0] === expected) equivalent = 'Correct interval expresses the same duration.';
  const jobStatus = { pending_job: 'running', latest_completed_job: 'completed', latest_failed_job: 'failed' }[key];
  if (jobStatus && typeof expected === 'string' && actual && typeof actual === 'object' &&
    (actual.job_id ?? actual.id) === expected && (!actual.status || actual.status === jobStatus) &&
    (key !== 'pending_job' || !actual.version || actual.version === all.find(c => c.key === 'latest_version')?.expected)) {
    equivalent = 'Correct job ID returned in an object rather than a string; provided current status/version do not contradict it.';
  }
  return equivalent ? { ...check, passed: true, strictPassed: false, equivalence: equivalent } : check;
}
for (const input of positionals) {
  const directory = resolve(input);
  const r = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  assert.ok(r.completedAt && !r.failure && !r.failures?.length, `${input} did not complete all arms.`);
  assert.equal(r.phases.length, 8); assert.equal(r.evaluations.length, 12);
  const layout = r.methodology.layout ?? 'overflow';
  const rows = [], aggregates = [];
  for (const variant of ['baseline', 'prepared']) {
    const allChecks = [], matchedChecks = [], allSemantic = [], matchedSemantic = [];
    const evaluations = r.evaluations.filter(e => e.variant === variant);
    for (const e of evaluations) {
      const phase = r.phases.find(p => p.phase === e.phase && p.variant === variant);
      const control = r.evaluations.find(p => p.phase === e.phase && p.variant === 'uncompressed-control');
      const controlKeys = new Set(control.checks.filter(c => c.passed).map(c => `${c.category}/${c.key}`));
      const matches = e.checks.filter(c => controlKeys.has(`${c.category}/${c.key}`));
      allChecks.push(...e.checks); matchedChecks.push(...matches);
      const semanticChecks = e.checks.map(c => semantic(c, e.checks));
      const semanticControl = control.checks.map(c => semantic(c, control.checks));
      const semanticKeys = new Set(semanticControl.filter(c => c.passed).map(c => `${c.category}/${c.key}`));
      const semanticMatches = semanticChecks.filter(c => semanticKeys.has(`${c.category}/${c.key}`));
      allSemantic.push(...semanticChecks); matchedSemantic.push(...semanticMatches);
      const after = await readFile(join(directory, `${e.phase}-${variant}-boundary-after.json`), 'utf8');
      const inheritedSummaries = [];
      for (const m of JSON.parse(after)) {
        if (m.role !== 'tool') continue;
        try {
          for (const summary of JSON.parse(m.content).summaries ?? []) {
            if (summary.turn_id?.endsWith('-boundary')) inheritedSummaries.push(summary);
          }
        } catch {}
      }
      const maintenance = r.requests.filter(x => x.stage === `${e.phase}-${variant}-boundary` && x.maintenance);
      const projectedIds = new Set();
      for (const req of maintenance) {
        const request = JSON.parse(await readFile(join(directory, `${req.id}-request.json`), 'utf8'));
        for (const m of request.messages) {
          if (m.role !== 'tool') continue;
          try { if (JSON.parse(m.content).contextCheckpointProjection) projectedIds.add(m.toolCallId); } catch {}
        }
      }
      rows.push({ phase: e.phase, variant,
        firstContinuationInputTokens: phase.firstPostCompactionUsage.inputTokens,
        followUpInputTokens: e.usage.inputTokens, rawControlInputTokens: control.usage.inputTokens,
        strict: score(e.checks), controlMatched: score(matches), semantic: score(semanticChecks),
        semanticControlMatched: score(semanticMatches),
        representationDifferences: semanticChecks.filter(c => c.equivalence),
        requirements: score(e.checks.filter(c => c.category === 'requirement')),
        facts: score(e.checks.filter(c => c.category === 'fact')),
        decisions: score(e.checks.filter(c => c.category === 'decision')),
        methods: phase.compactions.filter(e => e.kind === 'context_compaction_completed').map(e => e.payload.method),
        maintenanceRounds: maintenance.length, previewedToolResultIds: [...projectedIds],
        inheritedSummaries,
        failures: e.checks.filter(c => !c.passed).map(c => ({ ...c,
          ...(typeof c.expected === 'string' ? { expectedLiteralPresentInProjectedContext: after.includes(c.expected) } : {}) })),
      });
    }
    const requests = r.requests.filter(x => x.stage.includes(`-${variant}-`));
    aggregates.push({ variant, strict: score(allChecks), controlMatched: score(matchedChecks),
      semantic: score(allSemantic), semanticControlMatched: score(matchedSemantic),
      semanticRequirements: score(allSemantic.filter(c => c.category === 'requirement')),
      semanticFacts: score(allSemantic.filter(c => c.category === 'fact')),
      semanticDecisions: score(allSemantic.filter(c => c.category === 'decision')),
      requirements: score(allChecks.filter(c => c.category === 'requirement')),
      facts: score(allChecks.filter(c => c.category === 'fact')),
      decisions: score(allChecks.filter(c => c.category === 'decision')),
      preparationRounds: requests.filter(x => x.stage.includes('-prepare-')).length,
      maintenanceRounds: requests.filter(x => x.maintenance).length,
      totalModelRounds: requests.length,
      actualChainInputTokens: sum(requests, r => r.usage?.inputTokens),
      actualChainOutputTokens: sum(requests, r => r.usage?.outputTokens),
      actualChainCachedInputTokens: sum(requests, r => r.usage?.cachedInputTokens),
      actualNonAuditInputTokens: sum(requests.filter(r => !r.stage.endsWith('-audit')), r => r.usage?.inputTokens),
      actualNonAuditOutputTokens: sum(requests.filter(r => !r.stage.endsWith('-audit')), r => r.usage?.outputTokens),
      nonAuditRounds: requests.filter(r => !r.stage.endsWith('-audit')).length,
      boundaryElapsedMs: sum(r.phases.filter(p => p.variant === variant), p => p.elapsedMs),
      fourFollowUpInputTokens: sum(rows.filter(row => row.variant === variant), row => row.followUpInputTokens),
      fourFirstContinuationInputTokens: sum(rows.filter(row => row.variant === variant), row => row.firstContinuationInputTokens),
    });
  }
  rows.sort((a, b) => a.phase.localeCompare(b.phase) || a.variant.localeCompare(b.variant));
  const control = r.evaluations.filter(e => e.variant === 'uncompressed-control');
  analysis.runs.push({ directory, layout, config: r.config, methodology: r.methodology,
    startedAt: r.startedAt, completedAt: r.completedAt, modelRounds: r.requests.length,
    rows, aggregates, uncompressedControl: { strict: score(control.flatMap(e => e.checks)),
      semantic: score(control.flatMap(e => e.checks.map(c => semantic(c, e.checks)))),
      failures: control.flatMap(e => e.checks.filter(c => !c.passed).map(c => ({ phase: e.phase, ...c }))) },
  });
}
assert.ok(analysis.runs.every(run => JSON.stringify(run.config) === JSON.stringify(analysis.runs[0].config)),
  'Compared runs must use the same model, reasoning effort, output allowance and context configuration.');
await writeFile(resolve(values.output), JSON.stringify(analysis, null, 2), { flag: 'wx' });
for (const run of analysis.runs) console.log(JSON.stringify({ layout: run.layout, rows: run.rows.map(({ failures, inheritedSummaries, ...r }) => r),
  aggregates: run.aggregates, control: run.uncompressedControl }));
