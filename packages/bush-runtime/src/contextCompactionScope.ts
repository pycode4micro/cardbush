import { modelMessageSchema, type ModelMessage, type ModelRequest } from '@cardbush/bush-protocol';
import { createHash } from 'node:crypto';
import { validateConversation } from './sessionStore.js';
import { contextBudgetForPressure, contextCheckpointSlots, type ContextCheckpointFormat,
  type ContextCompactionSource, type ContextCompactionState, type ContextPressure } from './contextCompaction.js';

export interface CompactionSourceRange {
  turnId: string;
  startMessage: number;
  endMessageExclusive: number;
}

export interface ContextCompactionScope {
  state: ContextCompactionState;
  sources: ContextCompactionSource[];
  sourceRanges: CompactionSourceRange[];
  coveredTurnIds: string[];
  coveredMessageIds: string[];
  retainedMessageIds: string[];
  targetInputTokens: number;
  recentTokenBudget: number;
  retainedInputTokens: number;
}

export function contextCompactionInputDigest(messages: ModelMessage[], request: ModelRequest): string {
  return createHash('sha256').update(JSON.stringify({ messages: messages.map(message => modelMessageSchema.parse(message)),
    model: request.model, providerBinding: request.providerBinding, tools: request.tools,
    maxOutputTokens: request.maxOutputTokens, reasoningEffort: request.reasoningEffort,
    contextWindowTokens: request.metadata.contextWindowTokens })).digest('hex');
}

/** Whole exchanges, including reasoning/replay and every parallel receipt. */
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

/** Input targets are separate from the unchanged conversation output allowance.
 * Reserve a useful interval below the trigger, not merely below the hard limit. */
export function contextCompactionTarget(pressure: ContextPressure): number {
  const trigger = contextBudgetForPressure(pressure).compactionTriggerTokens;
  return Math.max(0, trigger - Math.min(16_000, Math.ceil(trigger * 0.2)));
}

function estimate(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    const images = 'images' in message ? message.images : undefined;
    const projected = images ? { ...message, images: images.map(image => ({ detail: image.detail })) } : message;
    return total + Math.ceil(JSON.stringify(projected).length / 4) + (images?.length ?? 0) * 1024;
  }, 0);
}

/** Select an old prefix and a bounded, verbatim recent suffix. IDs come from
 * canonical facts, never from model-authored summaries. The saved ranges freeze
 * an interrupted transaction even if token counting changes after restart. */
export function selectContextCompactionScope(input: {
  messages: ModelMessage[];
  sources: ContextCompactionSource[];
  state: ContextCompactionState;
  format: ContextCheckpointFormat;
  pressure: ContextPressure;
  activeTurnId: string;
  activeInputCount: number;
  messageIds: ReadonlyMap<string, Array<string | undefined>>;
  savedRanges?: CompactionSourceRange[];
  targetInputTokens?: number;
}): ContextCompactionScope {
  const targetInputTokens = input.targetInputTokens ?? contextCompactionTarget(input.pressure);
  const recentTokenBudget = Math.min(16_000, Math.floor(targetInputTokens * 0.2),
    Math.floor(input.pressure.estimatedPromptTokens * 0.2));
  // Calibrate selection to the complete measured request. Final admission still
  // counts the actual rebuilt request, including fixed tools and provider framing.
  const scale = Math.max(1, input.pressure.estimatedPromptTokens / Math.max(1, estimate(input.messages)));
  const units = input.sources.flatMap(source => {
    let cursor = source.startMessage;
    return completeContextUnits(input.messages.slice(source.startMessage, source.endMessageExclusive)).map(messages => {
      const start = cursor; cursor += messages.length;
      return { source, start, end: cursor, messages };
    });
  });
  const active = input.sources.find(source => source.turnId === input.activeTurnId);
  const activeInputEnd = (active?.startMessage ?? input.messages.length) + input.activeInputCount;
  let cut = input.messages.length;
  let retainedInputTokens = 0;
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!;
    if (unit.source.turnId === input.activeTurnId && unit.end <= activeInputEnd) {
      cut = unit.start;
      continue; // The current user input is always preserved separately.
    }
    // A prior summary is updated, not kept merely because it is recent.
    if (unit.messages.some(message => ('name' in message &&
      ['turn_context_summary', 'active_turn_checkpoint'].includes(message.name ?? '')) ||
      (message.role === 'assistant' && message.toolCalls.some(call => call.name === 'checkpoint_context')))) break;
    const tokens = Math.ceil(estimate(unit.messages) * scale);
    if (retainedInputTokens + tokens > recentTokenBudget) break;
    retainedInputTokens += tokens;
    cut = unit.start;
  }

  let ranges = input.savedRanges ?? input.sources.filter(source => source.target !== 'not_requested' &&
    Math.min(cut, source.endMessageExclusive) > (source.turnId === input.activeTurnId ? activeInputEnd : source.startMessage))
    .map(source => {
      let end = Math.min(cut, source.endMessageExclusive);
      const ids = input.messageIds.get(source.turnId) ?? [];
      // Legacy synthetic summaries have no canonical message identity. Migrate
      // them as a whole source rather than pretending to cover an invented ID.
      if (end < source.endMessageExclusive && (ids.length < end - source.startMessage ||
        ids.slice(0, end - source.startMessage).some(id => !id))) end = source.endMessageExclusive;
      return { turnId: source.turnId, startMessage: source.startMessage, endMessageExclusive: end };
    });
  ranges = structuredClone(ranges);
  let previousEnd = -1;
  for (const range of ranges) {
    const source = input.sources.find(item => item.turnId === range.turnId);
    if (!source || source.target === 'not_requested' || range.startMessage !== source.startMessage ||
      range.startMessage < previousEnd || range.endMessageExclusive <= range.startMessage ||
      range.endMessageExclusive > source.endMessageExclusive ||
      !units.some(unit => unit.source === source && unit.end === range.endMessageExclusive)) {
      throw new Error('Saved compaction scope does not match complete canonical source ranges.');
    }
    previousEnd = range.endMessageExclusive;
  }
  const activeRange = ranges.find(range => range.turnId === input.activeTurnId);
  const activeIds = input.messageIds.get(input.activeTurnId) ?? [];
  const boundaryId = activeRange && activeIds[activeRange.endMessageExclusive - activeRange.startMessage - 1];
  if (activeRange && !boundaryId) throw new Error('The active compaction boundary has no canonical message identity.');
  const state: ContextCompactionState = { revision: input.state.revision, totalTurns: input.state.totalTurns,
    unsummarizedTurnIds: ranges.filter(range => range.turnId !== input.activeTurnId).map(range => range.turnId),
    ...(boundaryId ? { activeTurn: { turnId: input.activeTurnId, throughMessageId: boundaryId } } : {}) };
  const slots = contextCheckpointSlots(state, input.format);
  const sources = input.sources.flatMap(source => {
    const range = ranges.find(item => item.turnId === source.turnId);
    if (!range) return [{ ...source, target: 'not_requested' }];
    const selected = { ...source, endMessageExclusive: range.endMessageExclusive,
      target: slots.find(slot => slot.turnId === source.turnId)!.target };
    // Locators must describe the selected range, not the full original Turn.
    if (range.endMessageExclusive !== source.endMessageExclusive) delete selected.last;
    if (selected.userRequest && selected.userRequest.message >= range.endMessageExclusive) delete selected.userRequest;
    return [selected, ...(range.endMessageExclusive < source.endMessageExclusive ? [{
      turnId: source.turnId, target: 'not_requested', startMessage: range.endMessageExclusive,
      endMessageExclusive: source.endMessageExclusive,
    }] : [])];
  });
  const coveredTurnIds: string[] = [], coveredMessageIds: string[] = [];
  for (const range of ranges.filter(range => range.turnId !== input.activeTurnId)) {
    const source = input.sources.find(source => source.turnId === range.turnId)!;
    if (range.endMessageExclusive === source.endMessageExclusive) coveredTurnIds.push(range.turnId);
    else {
      const ids = input.messageIds.get(range.turnId)?.slice(0, range.endMessageExclusive - range.startMessage);
      if (!ids?.length || ids.some(id => !id)) throw new Error('Partial compaction coverage requires canonical message identities.');
      coveredMessageIds.push(...ids as string[]);
    }
  }
  const retainedMessageIds = activeIds.slice(Math.max(input.activeInputCount,
    activeRange ? activeRange.endMessageExclusive - activeRange.startMessage : input.activeInputCount));
  if (retainedMessageIds.some(id => !id)) throw new Error('Retained active context requires canonical message identities.');
  retainedInputTokens = units.filter(unit => !(unit.source.turnId === input.activeTurnId && unit.end <= activeInputEnd) &&
    !ranges.some(range => range.turnId === unit.source.turnId && unit.end <= range.endMessageExclusive))
    .reduce((total, unit) => total + Math.ceil(estimate(unit.messages) * scale), 0);
  return { state, sources, sourceRanges: ranges, coveredTurnIds, coveredMessageIds,
    retainedMessageIds: retainedMessageIds as string[], targetInputTokens, recentTokenBudget, retainedInputTokens };
}
