import type { ModelMessage } from '@cardbush/bush-protocol';
import type { CompletedModelRound } from './modelRound.js';
import { validateConversation } from './sessionStore.js';
import { IncrementalCheckpoint } from './incrementalCheckpoint.js';
import { contextCompactionCorrectionMessage, isContextMaintenanceNotice } from './contextMaintenanceMessages.js';
import { bindContextCheckpointInput, ContextCheckpointInputError, contextCheckpointSlots, contextPressureNotice, type ContextCompactionSource,
  type ContextCheckpointFormat, type ContextCompactionState, type ContextPressure } from './contextCompaction.js';

export interface RestoredCompactionFailure {
  failures: number;
  outputTokens: number;
  correctionPartition?: boolean;
}

interface Fragment {
  turnId: string;
  active: boolean;
  startMessage: number;
  endMessageExclusive: number;
  units: ModelMessage[][];
}

interface Node {
  id: string;
  fragments: Fragment[];
  children?: Node[];
  result?: [ModelMessage, ModelMessage];
  failures: number;
  outputTokens: number;
  corrections: string[];
  loop?: IncrementalCheckpoint;
}

type SourceRange = CompactionJob['sourceRanges'][number];
type CompactionProgress = { kind: 'partition'; job: string; parts: SourceRange[][] }
  | { kind: 'correction'; job: string; message: string };

export interface CompactionJob {
  id: string;
  state: ContextCompactionState;
  messages: ModelMessage[];
  outputTokens: number;
  failures: number;
  sourceRanges: Array<{ turnId: string; startMessage: number; endMessageExclusive: number }>;
}

/** A maintenance transaction stages real checkpoint exchanges. No intermediate
 * output is added to the running conversation or applied to SessionStore.
 * Oversized sources are split only at complete message/Tool-exchange boundaries;
 * parents then ask the model to consolidate their children's real exchanges.
 */
export class ContextCompactionTransaction {
  readonly toolResultTurnIds = new Map<string, string>();
  readonly #root: Node;
  readonly #prefix: ModelMessage[];
  readonly #messages: ModelMessage[];
  readonly #sources: ContextCompactionSource[];
  readonly #state: ContextCompactionState;
  readonly #pressure: ContextPressure;
  readonly #format: ContextCheckpointFormat;
  readonly #initialOutput: number;
  readonly #maximumOutput: number;
  readonly #restoredFailures: Map<string, RestoredCompactionFailure>;
  readonly #callIds = new Set<string>();
  #current: Node;
  #nodes = 1;
  #attempts: number;
  #correctionRecovery = false;
  readonly incremental?: IncrementalCheckpoint;

  constructor(input: { messages: ModelMessage[]; prefixMessageCount: number;
    sources: ContextCompactionSource[]; state: ContextCompactionState; pressure: ContextPressure;
    outputTokens: number; maximumOutputTokens: number; inputFormat: ContextCheckpointFormat;
    restoredFailures?: Map<string, RestoredCompactionFailure>; restoredAttempts?: number; continuation?: ModelMessage[] }) {
    this.#messages = structuredClone(input.messages);
    for (const message of this.#messages) {
      if (message.role === 'assistant') for (const call of message.toolCalls) this.#callIds.add(call.id);
    }
    this.#prefix = this.#messages.slice(0, input.prefixMessageCount);
    this.#sources = structuredClone(input.sources);
    for (const source of input.sources) {
      for (const message of this.#messages.slice(source.startMessage, source.endMessageExclusive)) {
        if (message.role === 'tool') this.toolResultTurnIds.set(message.toolCallId, source.turnId);
      }
    }
    this.#state = structuredClone(input.state);
    this.#pressure = input.pressure;
    this.#format = input.inputFormat;
    this.#initialOutput = input.outputTokens;
    this.#maximumOutput = input.maximumOutputTokens;
    this.#restoredFailures = input.restoredFailures ?? new Map();
    this.#attempts = input.restoredAttempts ?? 0;
    const fragments = input.sources.filter(source => source.target !== 'not_requested').map(source => ({
      turnId: source.turnId, active: source.turnId === input.state.activeTurn?.turnId,
      startMessage: source.startMessage, endMessageExclusive: source.endMessageExclusive,
      units: completeContextUnits(this.#messages.slice(source.startMessage, source.endMessageExclusive)),
    }));
    if (!fragments.length) throw new Error('No authorized context sources can be compacted.');
    if (this.#format === 'incremental') this.incremental = new IncrementalCheckpoint(this.#state,
      contextPressureNotice(this.#state, this.#pressure, this.#format, this.#sources), input.continuation, this.#sources);
    this.#root = this.#node('root', fragments);
    this.#current = this.#root;
    if (this.incremental) {
      for (const message of this.incremental.history) {
        if (message.role === 'assistant') for (const call of message.toolCalls) this.#callIds.add(call.id);
      }
      this.#restorePartitions();
      this.#current = this.#next(this.#root) ?? this.#root;
    }
    if (this.#restoredFailures.get('root')?.correctionPartition) this.partitionForCorrection();
  }

  get originalState(): ContextCompactionState { return structuredClone(this.#state); }
  get isRoot(): boolean { return this.#current === this.#root; }
  /** Durable history always retains the original sources plus real maintenance
   * facts. A smaller dispatch projection must never replace this journal. */
  get canonicalMessages(): ModelMessage[] { return [...this.#messages, ...(this.incremental?.history ?? [])]; }

  /** Malformed-output recovery gets at most nine requests across both small
   * jobs and their final consolidation, including attempts before restart. */
  beginAttempt(): boolean {
    if (this.#correctionRecovery && this.#attempts >= 9) return false;
    this.#attempts += 1;
    return true;
  }

  job(): CompactionJob {
    if (this.incremental) return this.#incrementalJob();
    const node = this.#current;
    const state = this.#nodeState(node);
    let messages: ModelMessage[];
    let sources: ContextCompactionSource[];
    if (node === this.#root && !node.children) {
      messages = [...this.#messages];
      sources = this.#sources;
    } else {
      messages = [...this.#prefix];
      const slots = contextCheckpointSlots(state, this.#format);
      const stagedRanges = new Map<Node, { start: number; end: number }>();
      for (const child of node.children ?? []) {
        const start = messages.length;
        messages.push(...child.result!);
        stagedRanges.set(child, { start, end: messages.length });
      }
      sources = node.fragments.map((fragment, index) => {
        const children = node.children?.filter(child => child.fragments.some(part => part.turnId === fragment.turnId));
        if (children?.length) {
          // A grouped child exchange is appended once. Each parent slot points
          // to its exact field, preserving call identities and source ownership.
          return { turnId: fragment.turnId, target: slots[index]!.target,
            startMessage: stagedRanges.get(children[0]!)!.start,
            endMessageExclusive: stagedRanges.get(children.at(-1)!)!.end,
            checkpointSummaries: children.map(child => ({ message: stagedRanges.get(child)!.start,
              target: contextCheckpointSlots(this.#nodeState(child), this.#format).find(slot => slot.turnId === fragment.turnId)!.target })) };
        }
        const startMessage = messages.length;
        messages.push(...fragment.units.flat());
        return { turnId: fragment.turnId, target: slots[index]!.target,
          startMessage, endMessageExclusive: messages.length };
      });
    }
    validateConversation(messages);
    const notice = contextPressureNotice(state, this.#pressure, this.#format, sources);
    if (node !== this.#root || node.children) {
      notice.content += '\n' + (node === this.#root
        ? 'These indexed checkpoint exchanges are staged summaries of all requested original source ranges. Consolidate them into the requested final fields. No staged checkpoint has replaced the running conversation.'
        : 'This is one fragment of a staged context-compaction transaction. Summarize only the indexed fragment, not unseen portions of its Turn. Preserve uncertainty and exact identifiers. Runtime will consolidate all fragments before committing any replacement.') +
        '\nOriginal source ranges (zero-based in the frozen source conversation): ' + JSON.stringify(this.#ranges(node));
    }
    messages.push(notice);
    for (const correction of node.corrections) messages.push(contextCompactionCorrectionMessage(correction));
    return { id: node.id, state, messages, outputTokens: node.outputTokens,
      failures: node.failures, sourceRanges: this.#ranges(node) };
  }

  /** At most two short corrections append after the fixed notice, retaining
   * the measured prefix. Partial model output never enters the source request.
   * Increasing output does not change the normal Turn cap.
   */
  retry(message: string, increaseOutput = false): boolean {
    const node = this.#current;
    if (node.loop) {
      if (increaseOutput) node.outputTokens = Math.min(this.#maximumOutput, node.outputTokens * 2);
      const retry = node.loop.retry(message);
      if (retry && node !== this.#root) this.#recordProgress({ kind: 'correction', job: node.id, message });
      return retry;
    }
    node.failures += 1;
    if (node.failures < 3) node.corrections.push(message);
    if (increaseOutput) node.outputTokens = Math.min(this.#maximumOutput, node.outputTokens * 2);
    return node.failures < 3;
  }

  /** One bounded fallback, keeping existing source ownership and full Tool
   * exchanges. Current and historical work no longer compete in one job. */
  partitionForCorrection(): boolean {
    if (this.incremental) return false;
    const node = this.#current;
    if (!this.isRoot || node.children || node.fragments.length < 2) return false;
    const active = node.fragments.filter(fragment => fragment.active);
    const historical = node.fragments.filter(fragment => !fragment.active);
    const boundary = Math.ceil(node.fragments.length / 2);
    const parts = active.length && historical.length ? [historical, active]
      : [node.fragments.slice(0, boundary), node.fragments.slice(boundary)];
    if (!this.#partition(parts)) return false;
    this.#correctionRecovery = true;
    return true;
  }

  /** Return false rather than slice an indivisible message or a Tool exchange.
   * A failed merge cannot recursively summarize its own output forever.
   */
  partition(): boolean {
    const node = this.#current;
    if (node.children) return false;
    const fragments = node === this.#root && this.incremental
      ? node.fragments.filter(fragment => !this.incremental!.hasAccepted(this.#sourceNumber(fragment))) : node.fragments;
    if (!fragments.length) return false;
    let parts: Fragment[][];
    if (node.fragments.length > 1) parts = fragments.map(fragment => [fragment]);
    else {
      const fragment = fragments[0]!;
      if (fragment.units.length < 2) return false;
      const lengths = fragment.units.map(unit => JSON.stringify(unit).length);
      const target = lengths.reduce((sum, value) => sum + value, 0) / 2;
      let length = 0, boundary = 0;
      do { length += lengths[boundary++]!; } while (length < target && boundary < lengths.length - 1);
      const messageBoundary = fragment.startMessage + fragment.units.slice(0, boundary).reduce((sum, unit) => sum + unit.length, 0);
      parts = [
        [{ ...fragment, endMessageExclusive: messageBoundary, units: fragment.units.slice(0, boundary) }],
        [{ ...fragment, startMessage: messageBoundary, units: fragment.units.slice(boundary) }],
      ];
    }
    return this.#partition(parts);
  }

  #partition(parts: Fragment[][]): boolean {
    const node = this.#current;
    if (this.#nodes + parts.length > 64) return false;
    this.#nodes += parts.length;
    if (this.incremental) this.#recordProgress({ kind: 'partition', job: node.id,
      parts: parts.map(fragments => fragments.map(({ turnId, startMessage, endMessageExclusive }) => ({ turnId, startMessage, endMessageExclusive }))) });
    node.children = parts.map((fragments, index) => this.#node(`${node.id}/${index}`, fragments));
    this.#current = this.#next(this.#root) ?? this.#root;
    return true;
  }

  /** Validate against this job's authorization before staging its genuine pair.
   * Only a root result may be committed by the Runtime.
   */
  accept(result: CompletedModelRound): boolean {
    if (result.finishReason === 'length' || result.toolCalls.length !== 1 || result.toolCalls[0]!.name !== 'checkpoint_context') {
      throw new Error('A staged checkpoint requires one complete checkpoint_context call.');
    }
    const call = result.toolCalls[0]!;
    if (this.#callIds.has(call.id)) {
      throw new ContextCheckpointInputError('tool_call_id', 'a unique identity for this checkpoint exchange', call.id);
    }
    if (this.#current.loop) {
      const node = this.#current;
      const complete = node.loop!.submit(result);
      this.#callIds.add(call.id);
      if (this.isRoot) return complete;
      const pair = node.loop!.history.slice(-2) as [ModelMessage, ModelMessage];
      this.incremental!.history.push(...structuredClone(pair));
      if (complete) {
        node.result = structuredClone(pair);
        this.#current = this.#next(this.#root)!;
      }
      return false;
    }
    bindContextCheckpointInput(JSON.parse(call.argumentsText), this.#nodeState(this.#current), this.#format);
    if (this.isRoot) return true;
    this.#callIds.add(call.id);
    this.#current.result = [{ role: 'assistant', content: result.text,
      ...(result.reasoning ? { reasoningContent: result.reasoning } : {}),
      ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}),
      toolCalls: [{ id: call.id, name: call.name, argumentsText: call.argumentsText }],
    }, { role: 'tool', toolCallId: call.id, content: JSON.stringify({
      staged: true, applied: false, job: this.#current.id, sourceRanges: this.#ranges(this.#current),
      note: 'This fragment is staged for consolidation. The original conversation remains authoritative until the complete checkpoint is committed.',
    }) }];
    this.#current = this.#next(this.#root)!;
    return false;
  }

  #next(node: Node): Node | undefined {
    if (node.result) return undefined;
    for (const child of node.children ?? []) {
      const next = this.#next(child);
      if (next) return next;
    }
    return node;
  }

  #node(id: string, fragments: Fragment[]): Node {
    const restored = this.#restoredFailures.get(id);
    const node: Node = { id, fragments, corrections: [], failures: restored?.failures ?? 0,
      outputTokens: Math.min(this.#maximumOutput, restored?.outputTokens ?? this.#initialOutput) };
    if (this.incremental) {
      node.loop = id === 'root' ? this.incremental : new IncrementalCheckpoint(this.#state,
        { role: 'developer', name: 'context_pressure', content: 'Staged context checkpoint.' },
        this.#savedJobHistory(id), this.#sources, { sources: fragments.map(fragment => this.#sourceNumber(fragment)),
          stage: { job: id, sourceRanges: this.#ranges(node) } });
      if (id !== 'root' && node.loop.complete) node.result = node.loop.history.slice(-2) as [ModelMessage, ModelMessage];
    }
    return node;
  }

  #sourceNumber(fragment: Fragment): number {
    return contextCheckpointSlots(this.#state).findIndex(slot => slot.turnId === fragment.turnId);
  }

  #incrementalJob(): CompactionJob {
    const node = this.#current;
    if (node === this.#root && !node.children) return { id: node.id, state: this.originalState,
      messages: this.canonicalMessages, outputTokens: node.outputTokens,
      failures: node.loop!.failures, sourceRanges: this.#ranges(node) };
    const messages = [...this.#prefix];
    if (node !== this.#root) {
      // Earlier completed fragments provide reference/authorization context
      // without reattaching their raw images. They are background only; the
      // indexed ranges below still determine this job's ownership.
      this.#appendBackground(this.#root, node, messages);
      messages.push(...this.#savedJobHistory('root').slice(1));
    }
    const stagedRanges = new Map<Node, { start: number; end: number }>();
    for (const child of node.children ?? []) {
      const start = messages.length;
      messages.push(...child.result!);
      stagedRanges.set(child, { start, end: messages.length });
    }
    const sources = node.fragments.filter(fragment => node !== this.#root ||
      node.children?.some(child => child.fragments.some(part => part.turnId === fragment.turnId)) ||
      !this.incremental!.hasAccepted(this.#sourceNumber(fragment)))
      .map(fragment => {
        const target = `source ${this.#sourceNumber(fragment)}`;
        const children = node.children?.filter(child => child.fragments.some(part => part.turnId === fragment.turnId));
        if (children?.length) return { turnId: fragment.turnId, target,
          startMessage: stagedRanges.get(children[0]!)!.start, endMessageExclusive: stagedRanges.get(children.at(-1)!)!.end,
          // A completed staged receipt carries every accepted model-authored
          // summary, even when its last call submitted only one source.
          checkpointSummaries: children.map(child => ({ message: stagedRanges.get(child)!.start + 1,
            target: `summaries[source=${this.#sourceNumber(fragment)}].summary` })) };
        const startMessage = messages.length;
        messages.push(...fragment.units.flat());
        const original = this.#sources.find(source => source.turnId === fragment.turnId)?.userRequest;
        return { turnId: fragment.turnId, target, startMessage, endMessageExclusive: messages.length,
          ...(original && original.message >= fragment.startMessage && original.message < fragment.endMessageExclusive
            ? { userRequest: { ...original, message: startMessage + original.message - fragment.startMessage } } : {}) };
      });
    validateConversation(messages);
    const notice = contextPressureNotice(this.#state, this.#pressure, 'incremental', sources);
    notice.content += '\n' + (node.children
      ? 'Consolidate the indexed staged receipts into one summary for each selected source number. Only the quoted summaries fields belong to that source. No fragment has replaced the original conversation.'
      : 'This job contains only the indexed fragments, not unseen portions of their Turns. Submit updates only for these source numbers. Preserve uncertainty and exact identifiers; Runtime will ask for consolidation before accepting a whole source.') +
      '\nOriginal source ranges (zero-based in the frozen source conversation): ' + JSON.stringify(this.#ranges(node));
    messages.push(notice, ...this.#savedJobHistory(node.id).slice(1));
    return { id: node.id, state: this.originalState, messages, outputTokens: node.outputTokens,
      failures: node.loop!.failures, sourceRanges: this.#ranges(node) };
  }

  #recordProgress(progress: CompactionProgress): void {
    this.incremental!.history.push({ role: 'developer', name: 'context_compaction_progress', content: JSON.stringify(progress) });
  }

  #appendBackground(parent: Node, current: Node, messages: ModelMessage[]): void {
    const start = Math.min(...current.fragments.map(fragment => fragment.startMessage));
    for (const child of parent.children ?? []) {
      if (child.result && child.fragments.every(fragment => fragment.endMessageExclusive <= start)) messages.push(...child.result);
      else if (!child.result) this.#appendBackground(child, current, messages);
    }
  }

  #savedJobHistory(job: string): ModelMessage[] {
    const history: ModelMessage[] = [{ role: 'developer', name: 'context_pressure', content: 'Staged context checkpoint.' }];
    const saved = this.incremental!.history;
    for (let index = 1; index < saved.length; index++) {
      const message = saved[index]!;
      if (isContextMaintenanceNotice(message, 'context_compaction_progress')) {
        const progress = JSON.parse(message.content) as CompactionProgress;
        if (progress.kind === 'correction' && progress.job === job) history.push(contextCompactionCorrectionMessage(progress.message));
      } else if (isContextMaintenanceNotice(message, 'context_compaction_correction')) {
        if (job === 'root') history.push(message);
      } else {
        const receipt = saved[++index]!;
        const outcome = JSON.parse(receipt.content) as { staged?: boolean; job?: string };
        if (outcome.staged ? outcome.job === job : job === 'root') history.push(message, receipt);
      }
    }
    return history;
  }

  #restorePartitions(): void {
    const nodes = new Map([['root', this.#root]]);
    for (const message of this.incremental!.history) {
      if (!isContextMaintenanceNotice(message, 'context_compaction_progress')) continue;
      const progress = JSON.parse(message.content) as CompactionProgress;
      if (progress.kind !== 'partition') continue;
      const node = nodes.get(progress.job);
      if (!node || node.children || !progress.parts.length || this.#nodes + progress.parts.length > 64) throw new Error('Invalid saved context partition.');
      const parts = progress.parts.map(ranges => ranges.map(range => {
        const origin = node.fragments.find(fragment => fragment.turnId === range.turnId &&
          fragment.startMessage <= range.startMessage && fragment.endMessageExclusive >= range.endMessageExclusive);
        if (!origin) throw new Error('Saved context fragment is outside its original source.');
        const boundaries = [origin.startMessage];
        for (const unit of origin.units) boundaries.push(boundaries.at(-1)! + unit.length);
        const start = boundaries.indexOf(range.startMessage), end = boundaries.indexOf(range.endMessageExclusive);
        if (start < 0 || end <= start) throw new Error('Saved context fragment separates a complete Tool exchange.');
        return { ...origin, ...range, units: origin.units.slice(start, end) };
      }));
      this.#nodes += parts.length;
      node.children = parts.map((fragments, index) => this.#node(`${node.id}/${index}`, fragments));
      for (const child of node.children) nodes.set(child.id, child);
    }
  }

  #nodeState(node: Node): ContextCompactionState {
    return { revision: this.#state.revision, totalTurns: this.#state.totalTurns,
      unsummarizedTurnIds: node.fragments.filter(fragment => !fragment.active).map(fragment => fragment.turnId),
      ...(node.fragments.some(fragment => fragment.active) ? { activeTurn: this.#state.activeTurn } : {}) };
  }

  #ranges(node: Node) {
    return node.fragments.map(({ turnId, startMessage, endMessageExclusive }) => ({ turnId, startMessage, endMessageExclusive }));
  }
}

/** Preserve assistant reasoning, all parallel calls and all their receipts as
 * one unit. No prose, arguments, or provider-owned replay data is byte-sliced.
 */
export function completeContextUnits(messages: ModelMessage[]): ModelMessage[][] {
  validateConversation(messages);
  const units: ModelMessage[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const unit = [message];
    if (message.role === 'assistant' && message.toolCalls.length) {
      for (let count = 0; count < message.toolCalls.length; count++) unit.push(messages[++index]!);
    }
    units.push(unit);
  }
  return units;
}

/** Structured context errors only. Authorization and other permanent failures
 * never become compaction retries merely because their prose mentions tokens.
 */
export function isContextLengthFailure(error: { code: string; status?: number }): boolean {
  return (error.status === undefined || [400, 413, 422].includes(error.status)) &&
    ['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded', 'input_tokens_exceeded'].includes(error.code);
}
