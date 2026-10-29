# Memory maintenance

[English](memory-maintenance.en.md) · [简体中文](memory-maintenance.md)

Ordinary conversations and Assistant completion hooks schedule local maintenance only. Total token usage no longer triggers automatic model summarization. `summary_for_user` still supplies final-response presentation and optional current-turn habit/prediction writes; a failed memory write does not suppress the response.

Recall no longer copies subsequent user messages into the evidence queue. Existing evidence is retained for optional manual verification. Explicit evaluations may use `observe`; ordinary conversations do not.

## Local maintenance and capacity

- Writes deduplicate content, conditions and expiry and preserve operation receipt idempotency. Recall excludes expired, withdrawn and superseded records. Predictions default to seven-day expiry; long-lived habits without an expiry do not expire merely through age or lack of recent recall.
- Evidence without pending predictions is archived through existing history, preserving source text, provenance and undo. At most 128 records are archived per pass. If history is full, evidence remains and reads/maintenance continue.
- Concurrent completion maintenance coalesces, at most once per minute. Status reads can also maintain locally. A manual model task's snapshot prevents archival during that task.
- Recallable memories and evidence each have a separate 8,000-active-record protection limit. Expired/inactive records do not consume active capacity. Evidence does not consume the recallable-memory count, effective tokens or write allowance.
- Manual model thresholds are not storage limits. Crossing 10,000 or 80,000 tokens neither refuses memory writes nor calls a model. A multi-record transaction checks capacity together; deduplication of existing entries remains possible at capacity.
- Relevance retrieval, pagination and recall token budgets remain independent. History has its own bound and explicit cleanup controls.

## Optional model organization

Settings keeps manual organization collapsed by default; viewing/changing settings makes no model call. Explicit execution explains that it incurs usage. Legacy evidence and verification counts are displayed separately.

The existing `RuntimeInternalTaskRunner` owns requests, streaming, retry, timeout and cancellation. The memory module selects input, validates results and commits SQLite transactions. It creates neither an ordinary conversation nor tools, and does not mutate ordinary-session prompts or top-level schemas.

Prediction and habit thresholds are evaluated independently. The default 10,000-token threshold selects stages inside a manual task only. Each request uses a conservative local input budget of at most 10,000 tokens and reserves the configured output allowance in small contexts. Batches contain complete records or prediction/evidence pairs; conditions and evidence tails are never truncated. The configured reasoning effort and maximum output remain unchanged; incompatible configurations fail explicitly.

Evidence without pending predictions is archived. A durable ledger deduplicates processed pairs. Verification input contains predictions, conditions, actual user text and eligible pairs, not redundant database metadata, long source IDs, expiry timestamps or history counts. At most two Runtime verification requests overlap; denser batches go first. Short serialized commits accept changes made by the same task, while external edits still cause version conflicts.

Verification returns supported hits or explicit contradictions; everything else is unknown, not failure. Hits/contradictions need quotes from the corresponding user text. One prediction/user-turn pair cannot count twice. After verification, short predictions below threshold need no extra habit-derivation request. Only necessary compression or repeated feedback candidates proceed; repeated requests about one specific object do not automatically become universal habits. Habits are compressed only at their own threshold, an explicit habit-only task, or manual retry of a relevant failure. Unreplaced entries remain.

## Commit and recovery

Valid verification and independent merges commit incrementally. One invalid candidate does not roll back other valid results; the remaining candidates may receive one correction. Invalid JSON, cancellation or request failure preserves committed batches; retry resumes unprocessed pairs. Program logic inherits the earliest source expiry. Models do not invent expiry or append database timestamps to preferences. Freed verification space may support habit extraction, but the whole task cannot increase effective memory volume.

Failures do not start background summary jobs. Runtime still applies its bounded retry within the explicit task. UI distinguishes waiting, reasoning, generation, retry, validation and batch progress, with separate reasoning/result character counts. Provenance validation establishes source ownership and quotation consistency, not semantic correctness; model judgments still need quality sampling.

## Isolated replay and regression

`scripts/replay-memory-summary.mjs` reads a source snapshot and creates a new directory/database copy. It uses the real Runtime/provider configuration and preserves relative times. Credentials never enter reports. Private text, results and complete traces stay in the specified local directory and must not be committed.

```powershell
node scripts/replay-memory-summary.mjs --live `
  --source C:\path\snapshot.sqlite `
  --models C:\path\models.json `
  --model exact-model-id-or-name `
  --at 2026-10-16T09:04:36.666Z `
  --output C:\path\new-replay-directory `
  --baseline C:\path\failed-runtime-events.jsonl
```

`--live` incurs model usage. Output must not exist. `--at` preserves relative timing, not arbitrary historic database versions. Measure elapsed time, request usage/settings, accepted/rejected batches, retained habits, traceability and semantic samples separately. Lowering reasoning is not evidence of an architectural speedup. The dated 2026-10-16 replay report remains in the [original record](memory-maintenance.en.md); it is not a current success-rate claim.

After building protocol/runtime, run `individuation*.test.mjs`, `assistantMemory.test.mjs` and `runtimeInternalTask.test.mjs`. `individuationMaintenance.test.mjs` covers zero background model calls above thresholds, no recall evidence harvesting, separate capacity, undoable archival, snapshot protection and presentation. `node scripts/run-app-views-test.mjs composer-memory` covers the collapsed manual entry, no model calls on settings changes, evidence statistics and stable DOM/edits/progress during explicit work.
