import fs from 'node:fs';
import path from 'node:path';

import {
  createProductAgentTurnRequest,
} from '../packages/bush-product-agent/dist/index.js';
import { createLegacyProductAgentTurnRequest } from './cache-stable-legacy-baseline.mjs';
import {
  assembleContext,
  CacheChainTracker,
} from '../packages/bush-runtime/dist/index.js';

const sessionId = process.argv[2] || 'local-e5c33fca-74a4-4b71-a9c3-6b3accbfc894';
const sessionEvents = loadSessionEvents(sessionId);
const created = sessionEvents.find((event) => event.kind === 'session_created');
const turns = sessionEvents
  .filter((event) => event.kind === 'turn_committed')
  .map((event) => event.payload)
  .sort((left, right) => left.turnSequence - right.turnSequence);
if (turns.length === 0) {
  throw new Error(`No committed Turns found for ${sessionId}.`);
}

const metadata = created?.payload.metadata ?? {};
const projectDir = stringValue(
  metadata.projectDir ?? metadata.project_dir ?? metadata.workspace_dir,
);
const filesystemLocations = desktopFilesystemLocations();
const baselineTracker = new CacheChainTracker();
const bypassTracker = new CacheChainTracker();
let baselineSession = emptySession(sessionId, metadata, turns[0].createdAt);
let bypassSession = emptySession(sessionId, metadata, turns[0].createdAt);
let previousBaselineMessages = [];
let previousBypassMessages = [];
let bypassEnvironmentLocalDate;
const rows = [];

for (const turn of turns) {
  const primaryUser = turn.messages.find((message) =>
    message.message.role === 'user' &&
    message.message.visibility !== 'internal' &&
    message.message.name !== 'turn_guidance',
  );
  if (!primaryUser || primaryUser.message.role !== 'user') {
    continue;
  }
  const commonInput = {
    requestId: `replay_request_${turn.turnId}`,
    sessionId,
    turnId: turn.turnId,
    messageId: primaryUser.messageId,
    createdAt: primaryUser.createdAt,
    localDate: primaryUser.createdAt.slice(0, 10),
    userText: primaryUser.message.content,
    userMessageName: primaryUser.message.name,
    model: 'cache-replay-fixture',
    tools: [],
    projectDir,
    workspaceDir: projectDir,
    images: primaryUser.message.images?.map((image) => image.url),
    filesystemLocations,
    permissionMode: 'task_free',
    planEnabled: true,
  };
  const baselineRequest = createLegacyProductAgentTurnRequest(commonInput);
  const bypassRequest = createProductAgentTurnRequest({
    ...commonInput,
    sessionEnvironmentLocalDate: bypassEnvironmentLocalDate,
  });
  const baselineFirst = modelRequest(
    baselineRequest,
    assembleContext({
      session: baselineSession,
      prefix: baselineRequest.prefixMessages,
      current: baselineRequest.inputMessages.map((message) => message.message),
    }).messages,
  );
  const bypassFirst = modelRequest(
    bypassRequest,
    assembleContext({
      session: bypassSession,
      prefix: bypassRequest.prefixMessages,
      current: bypassRequest.inputMessages.map((message) => message.message),
    }).messages,
  );
  const baselineObservation = baselineTracker.observe(baselineFirst);
  const bypassObservation = bypassTracker.observe(bypassFirst);
  rows.push({
    turn: turn.turnSequence,
    status: turn.status,
    images: primaryUser.message.images?.length ?? 0,
    actualCachePercent: percent(
      turn.usage.cachedInputTokens,
      turn.usage.inputTokens,
    ),
    baselineBreak: baselineObservation.frozenPrefixBreak,
    baselineBreakIndex: baselineObservation.breakIndex,
    baselineReusablePercent: sharedCharacterPercent(
      baselineFirst.messages,
      baselineObservation.sharedPrefixMessages,
      previousBaselineMessages,
    ),
    bypassBreak: bypassObservation.frozenPrefixBreak,
    bypassBreakIndex: bypassObservation.breakIndex,
    bypassReusablePercent: sharedCharacterPercent(
      bypassFirst.messages,
      bypassObservation.sharedPrefixMessages,
      previousBypassMessages,
    ),
  });

  const bypassTurn = projectBypassCommittedTurn(turn, bypassRequest, primaryUser.messageId);
  baselineSession = appendTurn(baselineSession, turn);
  bypassSession = appendTurn(bypassSession, bypassTurn);
  bypassEnvironmentLocalDate = commonInput.localDate;

  const baselineSeedSession = replaceLastTurn(
    baselineSession,
    withoutTerminalAssistant(turn),
  );
  const bypassSeedSession = replaceLastTurn(
    bypassSession,
    withoutTerminalAssistant(bypassTurn),
  );
  const baselineSeed = modelRequest(
    baselineRequest,
    assembleContext({
      session: baselineSeedSession,
      prefix: baselineRequest.prefixMessages,
    }).messages,
  );
  const bypassSeed = modelRequest(
    bypassRequest,
    assembleContext({
      session: bypassSeedSession,
      prefix: bypassRequest.prefixMessages,
    }).messages,
  );
  if (!sameMessages(baselineFirst.messages, baselineSeed.messages)) {
    baselineTracker.observe(baselineSeed);
  }
  if (!sameMessages(bypassFirst.messages, bypassSeed.messages)) {
    bypassTracker.observe(bypassSeed);
  }
  previousBaselineMessages = baselineSeed.messages;
  previousBypassMessages = bypassSeed.messages;
}

const measuredTurns = rows.filter((row) => row.turn > 1);
const summary = {
  sessionId,
  turns: rows.length,
  baselineFrozenPrefixBreaks: measuredTurns.filter((row) => row.baselineBreak).length,
  bypassFrozenPrefixBreaks: measuredTurns.filter((row) => row.bypassBreak).length,
  baselineAverageReusablePercent: average(
    measuredTurns.map((row) => row.baselineReusablePercent),
  ),
  bypassAverageReusablePercent: average(
    measuredTurns.map((row) => row.bypassReusablePercent),
  ),
};

console.table(rows);
console.log(JSON.stringify(summary, null, 2));

function loadSessionEvents(targetSessionId) {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable.');
  const directory = path.join(appData, 'cardbush', 'runtime-state', 'sessions');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const records = fs.readFileSync(path.join(directory, entry.name), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const events = records.map((record) => record.event).filter(Boolean);
    if (events.some((event) => event.sessionId === targetSessionId)) return events;
  }
  throw new Error(`Session ${targetSessionId} was not found.`);
}

function emptySession(targetSessionId, sessionMetadata, createdAt) {
  return {
    protocol: 'bush.session_snapshot.v1',
    sessionId: targetSessionId,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    turns: [],
    supersededMessageIds: [],
    metadata: sessionMetadata,
  };
}

function appendTurn(session, turn) {
  return {
    ...session,
    revision: session.revision + 1,
    updatedAt: turn.completedAt,
    turns: [...session.turns, turn],
  };
}

function replaceLastTurn(session, turn) {
  return {
    ...session,
    turns: [...session.turns.slice(0, -1), turn],
  };
}

function projectBypassCommittedTurn(turn, request, primaryUserMessageId) {
  const inputMessages = request.inputMessages.map((input, index) => ({
    messageId: input.messageId,
    turnId: turn.turnId,
    turnSequence: turn.turnSequence,
    messageIndex: index,
    createdAt: input.createdAt,
    message: input.message,
  }));
  const remaining = turn.messages
    .filter((message) => message.messageId !== primaryUserMessageId)
    .map((message, index) => ({
      ...message,
      messageIndex: inputMessages.length + index,
    }));
  return {
    ...turn,
    messages: [...inputMessages, ...remaining],
  };
}

function withoutTerminalAssistant(turn) {
  const lastMessage = turn.messages.at(-1);
  const lastAssistantIndex =
    lastMessage?.message.role === 'assistant' &&
    (lastMessage.message.toolCalls?.length ?? 0) === 0
      ? turn.messages.length - 1
      : -1;
  if (lastAssistantIndex < 0) return turn;
  return {
    ...turn,
    messages: turn.messages.filter((_, index) => index !== lastAssistantIndex),
  };
}

function modelRequest(request, messages) {
  return {
    protocol: 'bush.model_request.v1',
    requestId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    model: request.model,
    providerBinding: request.providerBinding,
    messages,
    tools: request.tools,
    maxOutputTokens: request.maxOutputTokens,
    reasoningEffort: request.reasoningEffort,
    requestCapabilities: request.requestCapabilities,
    permissionMode: request.permissionMode,
    metadata: request.metadata,
  };
}

function desktopFilesystemLocations() {
  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
  return desktop
    ? [{ id: 'desktop', name: 'Desktop', path: desktop }]
    : [];
}

function sharedCharacterPercent(current, sharedCount, previous) {
  if (previous.length === 0) return null;
  const previousCharacters = messageCharacters(previous);
  if (previousCharacters === 0) return 100;
  return Number((100 * messageCharacters(current.slice(0, sharedCount)) /
    previousCharacters).toFixed(2));
}

function messageCharacters(messages) {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function sameMessages(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function percent(cached, input) {
  return input ? Number((100 * (cached ?? 0) / input).toFixed(2)) : null;
}

function average(values) {
  const numbers = values.filter((value) => typeof value === 'number');
  return numbers.length === 0
    ? null
    : Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(2));
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}
