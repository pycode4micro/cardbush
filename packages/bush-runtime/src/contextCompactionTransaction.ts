import type { ModelMessage } from '@cardbush/bush-protocol';
import type { CompletedModelRound } from './modelRound.js';
import { validateConversation } from './sessionStore.js';
import { IncrementalCheckpoint } from './incrementalCheckpoint.js';
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
}

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
    this.#root = this.#node('root', fragments);
    this.#current = this.#root;
    if (this.#format === 'incremental') this.incremental = new IncrementalCheckpoint(this.#state,
      contextPressureNotice(this.#state, this.#pressure, this.#format, this.#sources), input.continuation, this.#sources);
    if (this.#restoredFailures.get('root')?.correctionPartition) this.partitionForCorrection();
  }

  get originalState(): ContextCompactionState { return structuredClone(this.#state); }
  get isRoot(): boolean { return this.#current === this.#root; }

  /** Malformed-output recovery gets at most nine requests across both small
   * jobs and their final consolidation, including attempts before restart. */
  beginAttempt(): boolean {
    if (this.#correctionRecovery && this.#attempts >= 9) return false;
    this.#attempts += 1;
    return true;
  }

  job(): CompactionJob {
    if (this.incremental) return { id: 'root', state: this.originalState,
      messages: [...this.#messages, ...this.incremental.history], outputTokens: this.#root.outputTokens,
      failures: this.incremental.failures, sourceRanges: this.#ranges(this.#root) };
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
    for (const correction of node.corrections) messages.push({ role: 'user', name: 'context_compaction_correction',
      visibility: 'internal', content: correction });
    return { id: node.id, state, messages, outputTokens: node.outputTokens,
      failures: node.failures, sourceRanges: this.#ranges(node) };
  }

  /** At most two short corrections append after the fixed notice, retaining
   * the measured prefix. Partial model output never enters the source request.
   * Increasing output does not change the normal Turn cap.
   */
  retry(message: string, increaseOutput = false): boolean {
    const node = this.#current;
    if (this.incremental) {
      if (increaseOutput) node.outputTokens = Math.min(this.#maximumOutput, node.outputTokens * 2);
      return this.incremental.retry(message);
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
    if (this.incremental) return false;
    const node = this.#current;
    if (node.children) return false;
    let parts: Fragment[][];
    if (node.fragments.length > 1) parts = node.fragments.map(fragment => [fragment]);
    else {
      const fragment = node.fragments[0]!;
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
    node.children = parts.map((fragments, index) => this.#node(`${node.id}/${index}`, fragments));
    this.#current = node.children[0]!;
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
    if (this.incremental) return this.incremental.submit(result);
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
    return { id, fragments, corrections: [], failures: restored?.failures ?? 0,
      outputTokens: Math.min(this.#maximumOutput, restored?.outputTokens ?? this.#initialOutput) };
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
