import type { ModelMessage } from '@cardbush/bush-protocol';
import type { CompletedModelRound } from './modelRound.js';
export { isContextLengthFailure } from './modelFailurePolicy.js';
import { validateConversation } from './sessionStore.js';
import { completeContextUnits } from './contextCompactionScope.js';
export { completeContextUnits } from './contextCompactionScope.js';
import { IncrementalCheckpoint } from './incrementalCheckpoint.js';
import type { ContextTurnSource } from './contextAssembler.js';
import { checkpointSkillConstraintsIssue, hasActiveCheckpointSkillConstraints,
  hasInheritedCheckpointSkillConstraints } from './checkpointSkillConstraints.js';
import { checkpointSkillContractNotice, checkpointSkillReceiptEvidence, collectCheckpointSkillExcerpts,
  mergeCheckpointSkillExcerpts, packCheckpointSkillEvidence, validateCheckpointSkillEvidence, type CheckpointSkillContract,
  type CheckpointSkillEvidence } from './checkpointSkillEvidence.js';
import { contextCompactionCorrectionMessage, isContextMaintenanceNotice } from './contextMaintenanceMessages.js';
import { bindContextCheckpointInput, ContextCheckpointInputError, contextCheckpointSlots, contextPressureNotice, type ContextCompactionSource,
  type ContextCheckpointFormat, type ContextCompactionState, type ContextPressure } from './contextCompaction.js';

export interface RestoredCompactionFailure {
  failures: number;
  outputTokens: number;
  correctionPartition?: boolean;
  corrections?: string[];
}

interface Fragment {
  turnId: string;
  active: boolean;
  startMessage: number;
  endMessageExclusive: number;
  units: ModelMessage[][];
  unitRanges: Array<{ startMessage: number; endMessageExclusive: number }>;
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
  | { kind: 'correction' | 'refinement'; job: string; message: string };

export interface CompactionJob {
  id: string;
  state: ContextCompactionState;
  messages: ModelMessage[];
  outputTokens: number;
  failures: number;
  corrections?: string[];
  sourceRanges: Array<{ turnId: string; startMessage: number; endMessageExclusive: number;
    messageRanges?: Array<{ startMessage: number; endMessageExclusive: number }> }>;
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
  readonly #maximumNodes: number;
  #attempts: number;
  #correctionRecovery = false;
  readonly incremental?: IncrementalCheckpoint;
  #skillContracts = new Map<number, CheckpointSkillContract>();
  #skillEvidence: CheckpointSkillEvidence[] = [];
  readonly #handoffEvidence: Map<string, NonNullable<ContextTurnSource['handoffEvidence']>>;
  readonly #isolateSources: boolean;
  readonly #currentInput: ModelMessage[];

  get receiptEvidence(): Record<string, unknown> {
    return this.#skillEvidence.length ? { skill_evidence: packCheckpointSkillEvidence(this.#skillEvidence) } : {};
  }

  constructor(input: { messages: ModelMessage[]; prefixMessageCount: number;
    sources: ContextCompactionSource[]; state: ContextCompactionState; pressure: ContextPressure;
    outputTokens: number; maximumOutputTokens: number; inputFormat: ContextCheckpointFormat;
    restoredFailures?: Map<string, RestoredCompactionFailure>; restoredAttempts?: number; continuation?: ModelMessage[];
    handoffEvidence?: Map<string, NonNullable<ContextTurnSource['handoffEvidence']>>; isolateSources?: boolean;
    originalSourceRanges?: CompactionJob['sourceRanges']; currentInputMessages?: ModelMessage[] }) {
    this.#messages = structuredClone(input.messages);
    this.#isolateSources = input.isolateSources === true;
    this.#currentInput = structuredClone(input.currentInputMessages ?? []);
    this.#handoffEvidence = structuredClone(input.handoffEvidence ?? new Map());
    for (const message of this.#messages) {
      if (message.role === 'assistant') for (const call of message.toolCalls) this.#callIds.add(call.id);
    }
    this.#prefix = this.#messages.slice(0, input.prefixMessageCount);
    this.#sources = structuredClone(input.sources);
    for (const source of input.originalSourceRanges ?? input.sources) {
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
    const fragments = input.sources.filter(source => source.target !== 'not_requested').map(source => {
      const units: ModelMessage[][] = [], unitRanges: Fragment['unitRanges'] = [];
      for (const range of source.memberRanges ?? [source]) {
        let cursor = range.startMessage;
        for (const unit of completeContextUnits(this.#messages.slice(range.startMessage, range.endMessageExclusive))) {
          units.push(unit); unitRanges.push({ startMessage: cursor, endMessageExclusive: cursor + unit.length }); cursor += unit.length;
        }
      }
      return { turnId: source.turnId, active: source.turnId === input.state.activeTurn?.turnId,
        startMessage: source.startMessage, endMessageExclusive: source.endMessageExclusive, units, unitRanges };
    });
    if (!fragments.length) throw new Error('No authorized context sources can be compacted.');
    // Each split strictly divides complete source units. Bound work by those
    // units, not by an arbitrary number of preceding Turns (formerly 64 nodes).
    this.#maximumNodes = 2 * fragments.reduce((sum, fragment) => sum + fragment.units.length, 0) + 1;
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
    const job = this.#baseJob();
    this.#skillContracts = new Map();
    for (const fragment of this.#current.fragments) {
      if (!job.sourceRanges.some(range => range.turnId === fragment.turnId)) continue;
      const source = this.#sourceNumber(fragment);
      const children = this.#current.children?.filter(child => child.fragments.some(part => part.turnId === fragment.turnId));
      const owner = this.#sources.find(source => source.turnId === fragment.turnId);
      const handoffs = (owner?.memberTurnIds ?? [fragment.turnId]).flatMap(id => {
        const evidence = this.#handoffEvidence.get(id);
        return evidence && fragment.units.flat().some(message => message.role === 'assistant' && message.content === evidence.content) ? [evidence.excerpts] : [];
      });
      const excerpts = children?.length
        ? mergeCheckpointSkillExcerpts(children.map(child => checkpointSkillReceiptEvidence(child.result![1])
          .filter(item => item.source === source).flatMap(item => item.excerpts)))
        : mergeCheckpointSkillExcerpts([collectCheckpointSkillExcerpts(fragment.units.flat()), ...handoffs]);
      this.#skillContracts.set(source, { excerpts });
    }
    const notice = checkpointSkillContractNotice(this.#skillContracts);
    if (!notice) return job;
    // Append only to this dispatch's maintenance notice, never mutate the
    // canonical history, frozen system prefix or top-level Tool definitions.
    const messages = [...job.messages];
    let index = messages.length - 1;
    while (index >= 0 && !isContextMaintenanceNotice(messages[index]!, 'context_pressure')) index--;
    if (index < 0) throw new Error('Missing checkpoint maintenance notice.');
    messages[index] = { ...messages[index]!, content: messages[index]!.content + notice };
    return { ...job, messages };
  }

  #baseJob(): CompactionJob {
    if (this.incremental) return this.#incrementalJob();
    const node = this.#current;
    const state = this.#nodeState(node);
    let messages: ModelMessage[];
    let sources: ContextCompactionSource[];
    if (node === this.#root && !node.children && !this.#sources.some(source => source.memberRanges)) {
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
        const history = this.#sources.find(source => source.turnId === fragment.turnId)?.history;
        const children = node.children?.filter(child => child.fragments.some(part => part.turnId === fragment.turnId));
        if (children?.length) {
          // A grouped child exchange is appended once. Each parent slot points
          // to its exact field, preserving call identities and source ownership.
          return { turnId: fragment.turnId, target: slots[index]!.target,
            ...(history ? { history } : {}),
            startMessage: stagedRanges.get(children[0]!)!.start,
            endMessageExclusive: stagedRanges.get(children.at(-1)!)!.end,
            checkpointSummaries: children.map(child => ({ message: stagedRanges.get(child)!.start,
              target: contextCheckpointSlots(this.#nodeState(child), this.#format).find(slot => slot.turnId === fragment.turnId)!.target })) };
        }
        const startMessage = messages.length;
        messages.push(...fragment.units.flat());
        return { turnId: fragment.turnId, target: slots[index]!.target,
          ...(history ? { history } : {}),
          startMessage, endMessageExclusive: messages.length };
      });
    }
    if (this.#sources.some(source => source.memberRanges) && node.fragments.every(fragment => !fragment.active)) messages.push(...this.#currentInput);
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
      failures: node.failures, sourceRanges: this.#ranges(node),
      ...(node.corrections.length ? { corrections: [...node.corrections] } : {}) };
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

  /** Reopen only an uncommitted final candidate. Original sources and every
   * receipt stay in the journal; earlier partition jobs are not reused as facts
   * accepted under the new, tighter output target. */
  refine(message: string): boolean {
    if (!this.isRoot) return false;
    if (!this.incremental) return this.retry(message);
    if (!this.incremental.refine(message)) return false;
    this.#root.children = undefined;
    this.#nodes = 1;
    this.#restoredFailures.clear();
    return true;
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
    if (node.fragments.length > 1) {
      // Split by serialized volume, then let the provider's actual preflight
      // decide whether each batch needs another split. Many small sources share
      // one request, while a large source can still split at exchange boundaries.
      const boundary = balancedBoundary(fragments.map(fragment => JSON.stringify(fragment.units).length));
      parts = fragments.length === 1 ? [fragments] : [fragments.slice(0, boundary), fragments.slice(boundary)];
    }
    else {
      const fragment = fragments[0]!;
      if (fragment.units.length < 2) return false;
      const lengths = fragment.units.map(unit => JSON.stringify(unit).length);
      const boundary = balancedBoundary(lengths);
      parts = [
        [sliceFragment(fragment, 0, boundary)],
        [sliceFragment(fragment, boundary, fragment.units.length)],
      ];
    }
    return this.#partition(parts);
  }

  #partition(parts: Fragment[][]): boolean {
    const node = this.#current;
    if (this.#nodes + parts.length > this.#maximumNodes) return false;
    this.#nodes += parts.length;
    if (this.incremental) this.#recordProgress({ kind: 'partition', job: node.id,
      parts: parts.map(fragments => this.#ranges({ fragments } as Node)) });
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
    const job = this.job(); // Also supports callers that submit before inspecting job().
    const requiredSkillConstraints = this.#requiredSkillConstraintSources();
    if (this.#current.loop) {
      const node = this.#current;
      const complete = node.loop!.submit(result, requiredSkillConstraints, this.#skillContracts,
        new Set(job.sourceRanges.map(range => this.#sourceNumber(range))));
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
    const checkpoint = bindContextCheckpointInput(JSON.parse(call.argumentsText), this.#nodeState(this.#current), this.#format);
    const skillEvidence: CheckpointSkillEvidence[] = [];
    for (const item of [...checkpoint.summaries, ...(checkpoint.activeTurn ? [checkpoint.activeTurn] : [])]) {
      const source = this.#sourceNumber(item);
      const issue = checkpointSkillConstraintsIssue(item.summary, requiredSkillConstraints.has(source));
      if (issue) throw new ContextCheckpointInputError(`source ${source}.summary`, issue, item.summary);
      const contract = this.#skillContracts.get(source);
      if (contract?.excerpts.length) {
        const checked = validateCheckpointSkillEvidence(item.summary, contract);
        if (checked.issue) throw new ContextCheckpointInputError(`source ${source}.summary`, checked.issue, item.summary);
        skillEvidence.push({ source, excerpts: checked.excerpts });
      }
    }
    this.#skillEvidence = skillEvidence;
    if (this.isRoot) return true;
    this.#callIds.add(call.id);
    this.#current.result = [{ role: 'assistant', content: result.text,
      ...(result.reasoning ? { reasoningContent: result.reasoning } : {}),
      ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}),
      toolCalls: [{ id: call.id, name: call.name, argumentsText: call.argumentsText }],
    }, { role: 'tool', toolCallId: call.id, content: JSON.stringify({
      staged: true, applied: false, job: this.#current.id, sourceRanges: this.#ranges(this.#current),
      ...this.receiptEvidence,
      note: 'This fragment is staged for consolidation. The original conversation remains authoritative until the complete checkpoint is committed.',
    }) }];
    this.#current = this.#next(this.#root)!;
    return false;
  }

  /** Require an explicit review only where an actual prior checkpoint carried
   * active constraints. No cross-source inheritance from background fragments,
   * no semantic completion check and no extra persistence or generated files. */
  #requiredSkillConstraintSources(): Set<number> {
    const required = new Set<number>();
    for (const fragment of this.#current.fragments) {
      if (hasInheritedCheckpointSkillConstraints(fragment.units.flat())) required.add(this.#sourceNumber(fragment));
    }
    for (const child of this.#current.children ?? []) {
      if (!child.result) continue;
      const assistant = child.result[0];
      if (assistant.role !== 'assistant') throw new Error('A staged checkpoint must retain its assistant call.');
      const checkpoint = child.loop
        ? undefined : bindContextCheckpointInput(JSON.parse(assistant.toolCalls[0]!.argumentsText), this.#nodeState(child), this.#format);
      const summaries: Array<{ turnId: string; summary: string }> = child.loop
        ? (JSON.parse(child.result[1].content).summaries as Array<{ turn_id: string; summary: string }>)
          .map(item => ({ turnId: item.turn_id, summary: item.summary }))
        : [...checkpoint!.summaries, ...(checkpoint!.activeTurn ? [checkpoint!.activeTurn] : [])];
      for (const item of summaries) {
        if (hasActiveCheckpointSkillConstraints(item.summary)) required.add(this.#sourceNumber(item));
      }
    }
    return required;
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
    const node: Node = { id, fragments, corrections: [...(restored?.corrections ?? [])], failures: restored?.failures ?? 0,
      // Retry facts survive upgrades, but an old maintenance-only cap must not
      // lower today's conversation allowance when resuming an interrupted job.
      outputTokens: Math.min(this.#maximumOutput, Math.max(this.#initialOutput, restored?.outputTokens ?? this.#initialOutput)) };
    if (this.incremental) {
      node.loop = id === 'root' ? this.incremental : new IncrementalCheckpoint(this.#state,
        { role: 'developer', name: 'context_pressure', content: 'Staged context checkpoint.' },
        this.#savedJobHistory(id), this.#sources, { sources: fragments.map(fragment => this.#sourceNumber(fragment)),
          stage: { job: id, sourceRanges: this.#ranges(node) } });
      if (id !== 'root' && node.loop.complete) node.result = node.loop.history.slice(-2) as [ModelMessage, ModelMessage];
    }
    return node;
  }

  #sourceNumber(fragment: Pick<Fragment, 'turnId'>): number {
    return contextCheckpointSlots(this.#state).findIndex(slot => slot.turnId === fragment.turnId);
  }

  #incrementalJob(): CompactionJob {
    const node = this.#current;
    if (node === this.#root && !node.children) {
      const fragment = this.#isolateSources && node.fragments.find(item => !this.incremental!.hasAccepted(this.#sourceNumber(item)));
      if (fragment) {
        const messages = [...this.#prefix, ...fragment.units.flat()];
        const original = this.#sources.find(source => source.turnId === fragment.turnId)!;
        const delta = this.#prefix.length - fragment.startMessage;
        const source = { ...original, memberRanges: undefined, startMessage: this.#prefix.length, endMessageExclusive: messages.length,
          ...(original.userRequest ? { userRequest: { ...original.userRequest, message: original.userRequest.message + delta } } : {}) };
        // Keep the real current user boundary after historical replay. Some
        // thinking providers require reasoning for every assistant continuation
        // after the last user; isolated historical final prose is not a live
        // continuation. This is original input, never a fabricated user command.
        if (!fragment.active) messages.push(...this.#currentInput);
        const notice = contextPressureNotice(this.#state, this.#pressure, 'incremental', [source]);
        notice.content += '\nOnly the indexed source is supplied in this request. Previously accepted summaries are background; submit only this source number. The next source will receive its own input after acceptance. ' +
          'Use the message positions in THIS final notice. Earlier receipts retain positions in the original frozen conversation and must not be used to index this isolated request.';
        if (!fragment.active && this.#currentInput.length) notice.content += '\nCurrent user input outside the source range is background only; it is not owned by the historical source.';
        messages.push(...this.incremental!.attemptHistory.slice(1), notice);
        return { id: node.id, state: this.originalState, messages, outputTokens: node.outputTokens,
          failures: node.loop!.failures, sourceRanges: this.#ranges({ fragments: [fragment] } as Node) };
      }
      return { id: node.id, state: this.originalState,
      messages: [...this.#messages, ...this.incremental!.attemptHistory], outputTokens: node.outputTokens,
      failures: node.loop!.failures, sourceRanges: this.#ranges(node) };
    }
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
        const origin = this.#sources.find(source => source.turnId === fragment.turnId);
        const children = node.children?.filter(child => child.fragments.some(part => part.turnId === fragment.turnId));
        if (children?.length) return { turnId: fragment.turnId, target,
          ...(origin?.history ? { history: origin.history } : {}),
          startMessage: stagedRanges.get(children[0]!)!.start, endMessageExclusive: stagedRanges.get(children.at(-1)!)!.end,
          // A completed staged receipt carries every accepted model-authored
          // summary, even when its last call submitted only one source.
          checkpointSummaries: children.map(child => ({ message: stagedRanges.get(child)!.start + 1,
            target: `summaries[source=${this.#sourceNumber(fragment)}].summary` })) };
        const startMessage = messages.length;
        messages.push(...fragment.units.flat());
        const original = origin?.userRequest;
        return { turnId: fragment.turnId, target, startMessage, endMessageExclusive: messages.length,
          ...(origin?.history ? { history: origin.history } : {}),
          ...(original && original.message >= fragment.startMessage && original.message < fragment.endMessageExclusive
            ? { userRequest: { ...original, message: startMessage + original.message - fragment.startMessage } } : {}) };
      });
    validateConversation(messages);
    if (node.fragments.every(fragment => !fragment.active)) messages.push(...this.#currentInput);
    const notice = contextPressureNotice(this.#state, this.#pressure, 'incremental', sources);
    notice.content += '\n' + (node.children
      ? 'Consolidate the indexed staged receipts into one summary for each selected source number. Only the quoted summaries fields belong to that source. No fragment has replaced the original conversation.'
      : 'This job contains only the indexed fragments, not unseen portions of their Turns. Submit updates only for these source numbers. Preserve uncertainty and exact identifiers; Runtime will ask for consolidation before accepting a whole source.') +
      '\nOriginal source ranges (zero-based in the frozen source conversation): ' + JSON.stringify(this.#ranges(node));
    notice.content += '\nUse the message positions in THIS final notice; earlier receipt ranges refer to the original frozen conversation.';
    messages.push(...this.#savedJobHistory(node.id).slice(1), notice);
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
    const saved = this.incremental!.attemptHistory;
    for (let index = 1; index < saved.length; index++) {
      const message = saved[index]!;
      if (isContextMaintenanceNotice(message, 'context_compaction_progress')) {
        const progress = JSON.parse(message.content) as CompactionProgress;
        if (progress.kind === 'correction' && progress.job === job) history.push(contextCompactionCorrectionMessage(progress.message));
        else if (progress.kind === 'refinement' && job === 'root') history.push(message);
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
    for (const message of this.incremental!.attemptHistory) {
      if (!isContextMaintenanceNotice(message, 'context_compaction_progress')) continue;
      const progress = JSON.parse(message.content) as CompactionProgress;
      if (progress.kind !== 'partition') continue;
      const node = nodes.get(progress.job);
      if (!node || node.children || !progress.parts.length || this.#nodes + progress.parts.length > this.#maximumNodes) throw new Error('Invalid saved context partition.');
      const parts = progress.parts.map(ranges => ranges.map(range => {
        const origin = node.fragments.find(fragment => fragment.turnId === range.turnId &&
          fragment.startMessage <= range.startMessage && fragment.endMessageExclusive >= range.endMessageExclusive);
        if (!origin) throw new Error('Saved context fragment is outside its original source.');
        const start = origin.unitRanges.findIndex(unit => unit.startMessage === range.startMessage);
        const end = origin.unitRanges.findIndex(unit => unit.endMessageExclusive === range.endMessageExclusive) + 1;
        if (start < 0 || end <= start) throw new Error('Saved context fragment separates a complete Tool exchange.');
        const fragment = sliceFragment(origin, start, end);
        if (range.messageRanges && JSON.stringify(range.messageRanges) !== JSON.stringify(fragment.unitRanges)) throw new Error('Saved context fragment ranges changed.');
        return fragment;
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
    return node.fragments.map(({ turnId, startMessage, endMessageExclusive, unitRanges }) => ({ turnId, startMessage, endMessageExclusive,
      ...(unitRanges.some((range, index) => index > 0 && range.startMessage !== unitRanges[index - 1]!.endMessageExclusive)
        ? { messageRanges: unitRanges } : {}) }));
  }
}

function sliceFragment(fragment: Fragment, start: number, end: number): Fragment {
  const unitRanges = fragment.unitRanges.slice(start, end);
  return { ...fragment, startMessage: unitRanges[0]!.startMessage, endMessageExclusive: unitRanges.at(-1)!.endMessageExclusive,
    units: fragment.units.slice(start, end), unitRanges };
}

/** Preserve order while balancing serialized size, not the number of source Turns. */
function balancedBoundary(lengths: number[]): number {
  const target = lengths.reduce((sum, length) => sum + length, 0) / 2;
  let total = 0, boundary = 1, distance = Infinity;
  for (let index = 0; index < lengths.length - 1; index++) {
    total += lengths[index]!;
    const next = Math.abs(target - total);
    if (next < distance) { distance = next; boundary = index + 1; }
  }
  return boundary;
}
