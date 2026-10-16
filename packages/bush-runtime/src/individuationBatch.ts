import type { IndividuationSettings, ModelRequest } from '@cardbush/bush-protocol';
import { activeMemory, memoryMetadata } from './individuationJournal.js';
import { memoryTokens, memoryHash } from './individuationText.js';
import { memoryReviewCandidates, type MemoryRow, type MemorySnapshot, type MemorySummary } from './individuationStore.js';

export const MEMORY_BATCH_INPUT_TOKENS = 10_000;

/** Bound source work, not the model's reasoning allowance. Preserve the selected configuration. */
export function memoryTaskBudget(context: number, output: number) {
  if(!Number.isInteger(output)||output<=0||output>=context)
    throw Object.assign(new Error('The selected model output allowance must fit its context window.'),{code:'model_context_limits_invalid'});
  return { outputTokens: output, inputTokens: Math.min(MEMORY_BATCH_INPUT_TOKENS, context - output - 1024) };
}

export function memoryBatchMessages(snapshot: MemorySnapshot, instructions: string, reviewOnly = false): ModelRequest['messages'] {
  const ids = new Map(snapshot.records.map((row, index) => [row.id, String(index)]));
  const candidates = memoryReviewCandidates(snapshot.records);
  const pairs = new Set(snapshot.reviewPairs?.map(([prediction, evidence]) => `${prediction}:${evidence}`));
  const records = snapshot.records.map(row => {
    const meta = memoryMetadata(row);
    return { id: ids.get(row.id)!, kind: row.kind, text: row.text,
      ...(row.applies_when ? { applies_when: row.applies_when } : {}),
      ...(!reviewOnly && (row.kind === 'prediction' || row.kind === 'note') ? { hits: row.hits, misses: row.misses } : {}),
      ...(row.kind === 'evidence' ? { reviewable_predictions: (candidates.get(row.id) ?? [])
        .filter(id => !snapshot.reviewPairs || pairs.has(`${id}:${row.id}`)).map(id => ids.get(id)!) } : {}),
      ...(!reviewOnly && meta.user ? { user: meta.user } : {}),
      ...(meta.feedback ? { feedback: meta.feedback, turn: memoryHash(`${meta.session}:${meta.turn}`) } : {}),
    };
  });
  return [{ role: 'developer', content: instructions }, { role: 'user', content: JSON.stringify(records) }];
}

/** IDs are batch-local locators, as in context checkpoints. Unknown IDs remain invalid. */
export function bindMemoryBatchSummary(summary: MemorySummary, snapshot: MemorySnapshot): MemorySummary {
  const id = (value: string) => /^\d+$/.test(value) ? snapshot.records[Number(value)]?.id ?? `unknown:${value}` : `unknown:${value}`;
  return { habits: summary.habits.map(item => ({ ...item, sources: item.sources.map(id) })),
    predictions: summary.predictions.map(item => ({ ...item, sources: item.sources.map(id) })),
    reviews: summary.reviews.map(item => ({ ...item, prediction: id(item.prediction), evidence: id(item.evidence) })) };
}

/** Pack complete records and prediction/evidence pairs, never truncate evidence to fit. */
export function memoryBatches(snapshot: MemorySnapshot, instructions: string, budget: number, reviewOnly = false): MemorySnapshot[] {
  const byId = new Map(snapshot.records.map(row => [row.id, row]));
  const reviewed = new Set(snapshot.reviewedPairs ?? []);
  const pairs = [...memoryReviewCandidates(snapshot.records)].flatMap(([evidence, predictions]) =>
    predictions.filter(prediction => !reviewed.has(memoryHash(`${prediction}:${evidence}`)))
      .map(prediction => [prediction, evidence] as [string, string]));
  // Group by forecast, allowing evidence shared by multiple forecasts to remain one record per batch.
  pairs.sort((a, b) => byId.get(a[0])!.seq - byId.get(b[0])!.seq || byId.get(a[1])!.seq - byId.get(b[1])!.seq);
  const used = new Set<string>(), batches: MemorySnapshot[] = [];
  let rows = new Map<string, MemoryRow>(), pending: Array<[string, string]> = [];
  const make = (): MemorySnapshot => ({ ...snapshot, records: [...rows.values()], reviewPairs: [...pending],
    tokens: [...rows.values()].reduce((sum, row) => sum + row.tokens, 0) });
  const fits = () => Math.ceil(memoryTokens(JSON.stringify(memoryBatchMessages(make(), instructions, reviewOnly))) * 1.5) + 64 <= budget;
  const flush = () => { if (rows.size) batches.push(make()); rows = new Map(); pending = []; };
  const add = (ids: string[], pair?: [string, string]) => {
    const previous = new Map(rows), previousPairs = [...pending];
    for (const id of ids) rows.set(id, byId.get(id)!);
    if (pair) pending.push(pair);
    if (!fits()) {
      rows = previous; pending = previousPairs; flush();
      for (const id of ids) rows.set(id, byId.get(id)!);
      if (pair) pending.push(pair);
      if (!fits()) throw Object.assign(new Error('A complete memory source exceeds the maintenance input budget.'), { code: 'memory_batch_input_limit' });
    }
    for (const id of ids) used.add(id);
  };
  for (const pair of pairs) add(pair, pair);
  if (!reviewOnly) for (const row of snapshot.records) if (!used.has(row.id) && row.kind !== 'evidence') add([row.id]);
  flush();
  return batches;
}

/** The program, not the model, selects candidates after durable review accounting. */
export function memoryConsolidationSnapshot(snapshot: MemorySnapshot, settings: IndividuationSettings): MemorySnapshot {
  const active = snapshot.records.filter(row => activeMemory(row, Date.now()));
  const reviewed = new Set(snapshot.reviewedPairs ?? []), pending = new Set<string>();
  for (const [evidence, predictions] of memoryReviewCandidates(active)) for (const prediction of predictions)
    if (!reviewed.has(memoryHash(`${prediction}:${evidence}`))) pending.add(prediction);
  const forecasts = active.filter(row => (row.kind === 'prediction' || row.kind === 'note') && !pending.has(row.id));
  const overflow = forecasts.reduce((sum, row) => sum + row.tokens, 0) >= settings.eventTokenThreshold;
  const feedback = active.filter(row => row.kind === 'feedback');
  const turns = new Set(feedback.map(row => { const meta = memoryMetadata(row); return JSON.stringify([meta.session, meta.turn]); }));
  // Reviewed forecasts are already usable memory. A hit counter changing is not
  // itself a reason to spend another model request rewriting a small collection.
  const records = [...(overflow ? forecasts : []), ...(settings.habits && turns.size >= 2 ? feedback : [])];
  return { ...snapshot, records, reviewPairs: [], tokens: records.reduce((sum, row) => sum + row.tokens, 0) };
}
