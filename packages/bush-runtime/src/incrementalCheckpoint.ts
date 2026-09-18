import type { ModelMessage } from '@cardbush/bush-protocol';
import type { CompletedModelRound } from './modelRound.js';
import { contextCompactionCorrectionMessage, isContextMaintenanceNotice } from './contextMaintenanceMessages.js';
import { bindContextCheckpointInput, contextCheckpointSlots, type ContextCompactionState, type ContextCompactionSource } from './contextCompaction.js';

/** A derived view of genuine checkpoint calls and receipts, not a semantic
 * evaluator. The same full source prefix stays in place until completion. */
export class IncrementalCheckpoint {
  readonly history: ModelMessage[] = [];
  readonly #accepted = new Map<number, string>();
  readonly #calls = new Set<string>();
  failures = 0;

  constructor(readonly state: ContextCompactionState, notice: ModelMessage, saved: ModelMessage[] = [],
    readonly sources: ContextCompactionSource[] = []) {
    this.history.push(structuredClone(saved[0] ?? notice));
    for (let index = 1; index < saved.length; index++) {
      const message = saved[index]!;
      if (isContextMaintenanceNotice(message, 'context_compaction_correction')) {
        this.history.push(structuredClone(message)); this.failures++; continue;
      }
      const receipt = saved[++index];
      if (message.role !== 'assistant' || message.toolCalls.length !== 1 || !receipt ||
        receipt.role !== 'tool' || receipt.toolCallId !== message.toolCalls[0]!.id) {
        throw new Error('Incomplete saved checkpoint Tool exchange.');
      }
      const call = message.toolCalls[0]!;
      if (call.name !== 'checkpoint_context' || this.#calls.has(call.id)) throw new Error('Invalid saved checkpoint call identity.');
      const outcome = JSON.parse(receipt.content) as { accepted: number[]; rejected: Array<{ entry?: number }> };
      if (!Array.isArray(outcome.accepted) || !Array.isArray(outcome.rejected)) throw new Error('Missing saved checkpoint acceptance facts.');
      // Acceptance is a recorded Tool fact. Restore exactly those accepted
      // entries rather than applying today's requirements to old calls again.
      const updates = outcome.accepted.length ? JSON.parse(call.argumentsText).updates as Array<{ source: number; summary: string }> : [];
      for (const source of outcome.accepted) {
        const entry = updates.find((item, index) => item?.source === source && !outcome.rejected.some(rejected => rejected.entry === index));
        if (!Number.isInteger(source) || source < 0 || source >= contextCheckpointSlots(this.state).length ||
          this.#accepted.has(source) || typeof entry?.summary !== 'string') throw new Error('Saved acceptance does not identify an original summary entry.');
        this.#accepted.set(source, entry.summary.trim());
      }
      this.failures = outcome.accepted.length ? 0 : this.failures + 1;
      this.#calls.add(call.id);
      this.history.push(structuredClone(message), structuredClone(receipt));
    }
  }

  get complete(): boolean { return this.#accepted.size === contextCheckpointSlots(this.state).length; }
  get value(): { summaries: string[] } {
    if (!this.complete) throw new Error('Pending sources cannot be applied as a complete checkpoint.');
    return { summaries: contextCheckpointSlots(this.state).map((_, index) => this.#accepted.get(index)!) };
  }
  get checkpoint() { return bindContextCheckpointInput(this.value, this.state, 'ordered'); }

  retry(message: string): boolean {
    this.failures++;
    if (this.failures < 3) this.history.push(contextCompactionCorrectionMessage(message));
    return this.failures < 3;
  }

  submit(result: CompletedModelRound): boolean {
    const call = result.toolCalls[0]!;
    if (call.name !== 'checkpoint_context' || this.#calls.has(call.id)) throw new Error('Checkpoint calls must have unique identities.');
    const slots = contextCheckpointSlots(this.state);
    const accepted: number[] = [];
    const rejected: Array<{ entry?: number; source?: number; reason: string }> = [];
    let input: unknown;
    try { input = JSON.parse(call.argumentsText); }
    catch { rejected.push({ reason: 'Invalid JSON. Submit a complete updates object.' }); }
    if (!rejected.length) {
      const candidate = input as Record<string, unknown> | undefined;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        Object.keys(candidate).some(key => key !== 'updates') || !Array.isArray(candidate.updates) || !candidate.updates.length) {
        rejected.push({ reason: 'Expected only updates, an array with at least one {source, summary} entry.' });
      } else {
        for (const [entry, value] of candidate.updates.entries()) {
          const item = value as Record<string, unknown> | null;
          if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['source', 'summary'].includes(key)) ||
            !Number.isInteger(item.source) || Number(item.source) < 0 || Number(item.source) >= slots.length) {
            rejected.push({ entry, reason: 'Use an existing integer source number and only the source/summary fields.' }); continue;
          }
          const source = Number(item.source);
          if (this.#accepted.has(source)) {
            rejected.push({ entry, source, reason: 'Already accepted. Choose a remaining source; accepted text is unchanged.' }); continue;
          }
          if (typeof item.summary !== 'string' || !item.summary.trim() || item.summary.trim().length > 6000) {
            rejected.push({ entry, source, reason: 'Summary must be nonempty text of at most 6000 characters.' }); continue;
          }
          this.#accepted.set(source, item.summary.trim()); accepted.push(source);
        }
      }
    }
    this.failures = accepted.length ? 0 : this.failures + 1;
    const receipt = {
      accepted,
      accepted_sources: [...this.#accepted.keys()].sort((a, b) => a - b),
      remaining: slots.flatMap((slot, source) => {
        if (this.#accepted.has(source)) return [];
        const origin = this.sources.find(item => item.turnId === slot.turnId);
        return [{ source, ...(origin ? { startMessage: origin.startMessage, endMessageExclusive: origin.endMessageExclusive,
          ...(origin.userRequest ? { user_request: origin.userRequest.excerpt }
            : origin.first && 'excerpt' in origin.first ? { user_request: origin.first.excerpt } : {}) } : {}) }];
      }),
      rejected, complete: this.complete,
      ...(!accepted.length ? { requirement: 'This call made no progress. Submit at least one remaining source.' } : {}),
      ...(this.complete ? {
        // Exact model-authored texts, read from the accepted Tool calls. The
        // final receipt carries the complete checkpoint through exchange_v1;
        // no additional model merge or fabricated aggregate call is needed.
        summaries: slots.map((slot, source) => ({ source, turn_id: slot.turnId, current: slot.active, summary: this.#accepted.get(source)! })),
      } : {}),
    };
    this.#calls.add(call.id);
    this.history.push({ role: 'assistant', content: result.text,
      ...(result.reasoning ? { reasoningContent: result.reasoning } : {}),
      ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}),
      toolCalls: [{ id: call.id, name: call.name, argumentsText: call.argumentsText }],
    }, { role: 'tool', toolCallId: call.id, content: JSON.stringify(receipt) });
    return this.complete;
  }
}
