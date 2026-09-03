import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sessionId = process.argv[2] || 'local-e5c33fca-74a4-4b71-a9c3-6b3accbfc894';
const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA is unavailable.');

const runtimeRoot = path.join(appData, 'cardbush', 'runtime-state');
const runtime = loadRuntimeEvents(sessionId, path.join(runtimeRoot, 'events'));
const session = loadSession(sessionId, path.join(runtimeRoot, 'sessions'));
const toolJournal = loadToolExecutions(
  sessionId,
  path.join(runtimeRoot, 'tool-executions'),
);
const turns = session.events
  .filter((event) => event.kind === 'turn_committed')
  .map((event) => event.payload);
const intervals = turns.length > 0
  ? turns.map((turn) => ({
      start: Date.parse(turn.createdAt),
      end: Date.parse(turn.completedAt ?? turn.createdAt),
    }))
  : runtimeTurnIntervals(runtime.events);
const reasoningEvents = runtime.events
  .filter((event) => event.kind.startsWith('reasoning_segment_'))
  .sort(compareEvents);
const reasoningDeltaCount = runtime.counts.get('reasoning_segment_delta') ?? 0;
const assistantDeltaCount = runtime.counts.get('assistant_segment_delta') ?? 0;
const assistantSegmentCompletedCount =
  runtime.counts.get('assistant_segment_completed') ?? 0;
const assistantCompletedTurnIds = new Set(
  runtime.events
    .filter((event) => event.kind === 'assistant_segment_completed')
    .map((event) => event.turnId),
);
const assistantTerminalFallbackCommits = runtime.events.filter(
  (event) =>
    event.kind === 'turn_terminal' &&
    !assistantCompletedTurnIds.has(event.turnId),
).length;
const assistantSegmentIntegrity = verifyAssistantSegments(runtime.events);
const atomicAssistantCommits =
  assistantSegmentCompletedCount + assistantTerminalFallbackCommits;
const sidebarLiveFactUpdates = [
  'assistant_segment_completed',
  'tool_queued',
  'tool_running',
  'tool_returned',
  'tool_failed',
  'task_plan_updated',
].reduce((total, kind) => total + (runtime.counts.get(kind) ?? 0), 0);
const sidebarLifecycleCommits =
  2 * (runtime.counts.get('turn_terminal') ?? 0);
const projected = replayThinkingProjection(reasoningEvents, 120);
const messageRows = turns.reduce(
  (total, turn) => total + (Array.isArray(turn.messages) ? turn.messages.length : 0),
  0,
);
const committedMessages = turns.flatMap((turn) =>
  Array.isArray(turn.messages) ? turn.messages : [],
);
const messageRoleCounts = countBy(committedMessages, (entry) => entry.message?.role ?? 'unknown');
const conversationMessages = committedMessages.flatMap((entry) => {
  const role = entry.message?.role;
  if (role === 'tool' || role === 'system' || role === 'developer') return [];
  if (role !== 'assistant') return [entry];
  const { reasoningContent: _reasoningContent, ...message } = entry.message;
  return [{ ...entry, message }];
});
const fullMessageBytes = jsonBytes(committedMessages);
const conversationMessageBytes = jsonBytes(conversationMessages);
const fullToolRecordBytes = jsonBytes(toolJournal.records);
const toolSummaries = toolJournal.records.map(toolExecutionSummary);
const toolSummaryBytes = jsonBytes(toolSummaries);
const visibleUserRows = committedMessages.filter((entry) =>
  entry.message?.role === 'user' && !isInternalRuntimeMessage(entry),
).length;
const visibleAssistantRows = turns.reduce((total, turn) => {
  const messages = Array.isArray(turn.messages) ? turn.messages : [];
  const assistants = messages.filter((entry) => entry.message?.role === 'assistant');
  if (assistants.length === 0) return total;
  const guidanceBoundaries = messages.reduce((count, entry, index) =>
    entry.message?.role === 'assistant' &&
    messages[index + 1]?.message?.role === 'user' &&
    messages[index + 1]?.message?.name === 'turn_guidance'
      ? count + 1
      : count,
  0);
  return total + 1 + guidanceBoundaries;
}, 0);
const projectedReactRows = visibleUserRows + visibleAssistantRows;
const nonvisualProtocolRows =
  (messageRoleCounts.get('tool') ?? 0) +
  (messageRoleCounts.get('system') ?? 0) +
  (messageRoleCounts.get('developer') ?? 0);
const peakReasoningDeltasPerSecond = peakPerSecond(
  reasoningEvents.filter((event) => event.kind === 'reasoning_segment_delta'),
);
const scrollLog = logActivity(path.join(process.cwd(), 'logs', 'scroll.log'), intervals);
const compositionLog = logActivity(
  path.join(process.cwd(), 'logs', 'window-composition.log'),
  intervals,
  (payload) => payload.stage === 'composition-snapshot',
);
const observedUiPerformance = uiPerformanceHistory(
  path.join(process.cwd(), 'logs', 'ui-performance.log'),
  sessionId,
);

const report = {
  protocol: 'cardbush.ui_performance_replay.v1',
  sessionId,
  source: {
    sessionSnapshotAvailable: session.found,
    turns: turns.length,
    messageRows,
    sessionBytes: session.bytes,
    runtimeEventFiles: runtime.files,
    runtimeEventBytes: runtime.bytes,
    runtimeEvents: runtime.events.length,
  },
  eventCounts: Object.fromEntries(
    [...runtime.counts.entries()].sort((left, right) => right[1] - left[1]),
  ),
  rendererProjection: {
    reasoningDeltaCount,
    peakReasoningDeltasPerSecond,
    legacyApplicationRootInvalidations: reasoningDeltaCount,
    isolatedRuntimeRailContentCommits: projected.contentCommits,
    isolatedRuntimeRailClearCommits: projected.clearCommits,
    commitReductionPercent: percentReduction(
      reasoningDeltaCount,
      projected.contentCommits + projected.clearCommits,
    ),
    upperBoundLegacyMessageElementVisits: reasoningDeltaCount * messageRows,
    applicationRootInvalidationsAfterIsolation: 0,
    assistantDeltaCount,
    assistantSegmentCompletedCount,
    assistantSegmentIntegrity,
    assistantTerminalFallbackCommits,
    legacyAssistantTextCommits: assistantDeltaCount,
    atomicAssistantTextCommits: atomicAssistantCommits,
    assistantTextCommitReductionPercent: percentReduction(
      assistantDeltaCount,
      atomicAssistantCommits,
    ),
    legacyActiveAssistantRowMounts: assistantSegmentCompletedCount,
    stableActiveAssistantRowMounts: assistantCompletedTurnIds.size,
    activeAssistantRowMountReductionPercent: percentReduction(
      assistantSegmentCompletedCount,
      assistantCompletedTurnIds.size,
    ),
    estimatedSidebarLiveFactUpdates: sidebarLiveFactUpdates,
    sidebarSubmitDoneLifecycleCommits: sidebarLifecycleCommits,
    sidebarUpdateReductionPercent: percentReduction(
      sidebarLiveFactUpdates,
      sidebarLifecycleCommits,
    ),
  },
  historyProjection: {
    canonicalMessageRows: committedMessages.length,
    messageRoleCounts: Object.fromEntries(messageRoleCounts),
    conversationTransportRows: conversationMessages.length,
    nonvisualProtocolRowsElided: nonvisualProtocolRows,
    legacyTopLevelReactRows: projectedReactRows + nonvisualProtocolRows,
    projectedTopLevelReactRows: projectedReactRows,
    reactRowReductionPercent: percentReduction(
      projectedReactRows + nonvisualProtocolRows,
      projectedReactRows,
    ),
    fullMessageBytes,
    conversationMessageBytes,
    messageTransportReductionPercent: percentReduction(
      fullMessageBytes,
      conversationMessageBytes,
    ),
    privateReasoningBytesDeferred: committedMessages.reduce(
      (total, entry) => total + Buffer.byteLength(
        typeof entry.message?.reasoningContent === 'string'
          ? entry.message.reasoningContent
          : '',
      ),
      0,
    ),
    canonicalToolRecords: toolJournal.records.length,
    toolJournalBytes: toolJournal.bytes,
    fullToolRecordBytes,
    toolSummaryBytes,
    toolTransportReductionPercent: percentReduction(
      fullToolRecordBytes,
      toolSummaryBytes,
    ),
    combinedTransportBytesBefore: fullMessageBytes + fullToolRecordBytes,
    combinedTransportBytesAfter: conversationMessageBytes + toolSummaryBytes,
    combinedTransportReductionPercent: percentReduction(
      fullMessageBytes + fullToolRecordBytes,
      conversationMessageBytes + toolSummaryBytes,
    ),
    nativeResultBytesDeferred: toolJournal.records.reduce(
      (total, record) => total + jsonBytes(record.result),
      0,
    ),
    workspaceChangeDetailBytesDeferred: toolJournal.records.reduce(
      (total, record) => total + (record.workspaceChanges ?? []).reduce(
        (sum, change) => sum + jsonBytes(change.metadata ?? {}),
        0,
      ),
      0,
    ),
  },
  diagnosticResidue: {
    synchronousScrollLogWritesDuringSessionTurns: scrollLog.matches,
    scrollLogTotalLines: scrollLog.lines,
    capturePageSnapshotsDuringSessionTurns: compositionLog.matches,
    compositionLogTotalLines: compositionLog.lines,
  },
  observedUiPerformance,
};

console.log(JSON.stringify(report, null, 2));

function loadSession(targetSessionId, directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(directory, entry.name);
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source.includes(targetSessionId)) continue;
    const events = source.split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line).event)
      .filter((event) => event?.sessionId === targetSessionId);
    return { events, bytes: Buffer.byteLength(source), found: true };
  }
  return { events: [], bytes: 0, found: false };
}

function runtimeTurnIntervals(events) {
  const ranges = new Map();
  for (const event of events) {
    const timestamp = Date.parse(event.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    const current = ranges.get(event.turnId);
    if (!current) {
      ranges.set(event.turnId, { start: timestamp, end: timestamp });
      continue;
    }
    current.start = Math.min(current.start, timestamp);
    current.end = Math.max(current.end, timestamp);
  }
  return [...ranges.values()];
}

function verifyAssistantSegments(events) {
  const pendingBySegment = new Map();
  let matched = 0;
  let mismatched = 0;
  let completedWithoutDeltas = 0;
  for (const event of events) {
    if (
      event.kind !== 'assistant_segment_delta' &&
      event.kind !== 'assistant_segment_completed'
    ) {
      continue;
    }
    const key = [
      event.turnId,
      event.payload?.messageId,
      event.payload?.segmentId,
    ].join('\u0000');
    if (event.kind === 'assistant_segment_delta') {
      pendingBySegment.set(
        key,
        `${pendingBySegment.get(key) ?? ''}${String(event.payload?.delta ?? '')}`,
      );
      continue;
    }
    const streamed = pendingBySegment.get(key);
    if (streamed === undefined) completedWithoutDeltas += 1;
    else if (streamed === String(event.payload?.content ?? '')) matched += 1;
    else mismatched += 1;
    pendingBySegment.delete(key);
  }
  return {
    matched,
    mismatched,
    completedWithoutDeltas,
    unfinished: pendingBySegment.size,
  };
}

function loadRuntimeEvents(targetSessionId, directory) {
  const events = [];
  const counts = new Map();
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(directory, entry.name);
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source.includes(targetSessionId)) continue;
    files += 1;
    bytes += Buffer.byteLength(source);
    for (const line of source.split(/\r?\n/)) {
      if (!line) continue;
      const event = JSON.parse(line).event;
      if (event?.sessionId !== targetSessionId) continue;
      events.push(event);
      counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
    }
  }
  return { events, counts, bytes, files };
}

function loadToolExecutions(targetSessionId, directory) {
  const filePath = path.join(
    directory,
    `${createHash('sha256').update(targetSessionId).digest('hex')}.jsonl`,
  );
  if (!fs.existsSync(filePath)) return { records: [], bytes: 0 };
  const source = fs.readFileSync(filePath, 'utf8');
  const records = source.split(/\r?\n/).filter(Boolean).map((line) => {
    const envelope = JSON.parse(line);
    if (envelope?.record?.sessionId !== targetSessionId) {
      throw new Error(`Tool journal identity mismatch in ${filePath}.`);
    }
    return envelope.record;
  });
  return { records, bytes: Buffer.byteLength(source) };
}

function toolExecutionSummary(record) {
  return {
    protocol: 'bush.tool_execution_summary.v1',
    requestId: record.requestId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    round: record.round,
    ordinal: record.ordinal,
    recordedAt: record.recordedAt,
    toolCall: {
      protocol: record.toolCall.protocol,
      id: record.toolCall.id,
      name: record.toolCall.name,
    },
    outcome: record.outcome,
    ...(record.actionManifest ? { actionManifest: record.actionManifest } : {}),
    resultAvailable: Object.prototype.hasOwnProperty.call(record, 'result'),
    workspaceChanges: (record.workspaceChanges ?? []).map(({ metadata, ...change }) => ({
      ...change,
      detailAvailable: Object.keys(metadata ?? {}).length > 0,
    })),
    ...(record.error ? { error: record.error } : {}),
  };
}

function replayThinkingProjection(events, intervalMs) {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'features', 'composer', 'thinkingNoticeProjection.ts'),
    'utf8',
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  vm.runInNewContext(transpiled.outputText, { module, exports: module.exports });
  const clock = replayClock(events.length > 0 ? Date.parse(events[0].createdAt) : 0);
  let contentCommits = 0;
  let clearCommits = 0;
  const projection = module.exports.createThinkingNoticeProjection(
    (notice) => {
      if (notice) contentCommits += 1;
      else clearCommits += 1;
    },
    { intervalMs, scheduler: clock.scheduler },
  );
  for (const event of events) {
    clock.advanceTo(Date.parse(event.createdAt));
    projection.accept({
      id: String(event.payload?.segmentId ?? ''),
      turnId: event.turnId,
      phase: event.kind === 'reasoning_segment_started'
        ? 'start'
        : event.kind === 'reasoning_segment_completed'
          ? 'end'
          : 'delta',
      delta: event.kind === 'reasoning_segment_delta'
        ? String(event.payload?.delta ?? '')
        : '',
      createdAt: event.createdAt,
    });
  }
  clock.flush();
  projection.dispose();
  return { contentCommits, clearCommits };
}

function replayClock(initialNow) {
  let now = initialNow;
  let nextId = 1;
  const timers = new Map();
  const runUntil = (target) => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  };
  return {
    scheduler: {
      now: () => now,
      setTimer(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer(id) {
        timers.delete(id);
      },
    },
    advanceTo(target) {
      runUntil(Math.max(now, target));
    },
    flush() {
      while (timers.size > 0) {
        runUntil(Math.min(...[...timers.values()].map((timer) => timer.at)));
      }
    },
  };
}

function peakPerSecond(events) {
  const buckets = new Map();
  for (const event of events) {
    const bucket = Math.floor(Date.parse(event.createdAt) / 1000);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return Math.max(0, ...buckets.values());
}

function logActivity(filePath, intervals, predicate = () => true) {
  if (!fs.existsSync(filePath)) return { lines: 0, matches: 0 };
  let lines = 0;
  let matches = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    lines += 1;
    const record = JSON.parse(line);
    const at = Date.parse(record.at);
    if (predicate(record.payload ?? {}) && intervals.some((range) => at >= range.start && at <= range.end)) {
      matches += 1;
    }
  }
  return { lines, matches };
}

function uiPerformanceHistory(filePath, targetSessionId) {
  if (!fs.existsSync(filePath)) return { windows: 0 };
  const entries = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.payload?.sessionId === targetSessionId);
  const staticHistoryEntries = entries.filter((entry) => {
    const metrics = entry.payload?.metrics ?? {};
    const keys = Object.keys(metrics);
    return metrics.chat_panel_commit_ms?.count === 1 &&
      keys.every((key) => key === 'chat_panel_commit_ms' || key === 'main_thread_long_task_ms');
  });
  const commitValues = staticHistoryEntries.map((entry) =>
    Number(entry.payload.metrics.chat_panel_commit_ms.max ?? 0),
  );
  const intervals = staticHistoryEntries.slice(1).map((entry, index) =>
    Date.parse(entry.at) - Date.parse(staticHistoryEntries[index].at),
  ).filter((value) => Number.isFinite(value) && value > 0);
  return {
    windows: entries.length,
    staticHistoryCommitWindows: staticHistoryEntries.length,
    staticHistoryCommitMaxMs: Math.max(0, ...commitValues),
    staticHistoryCommitP95Ms: percentile(commitValues, 0.95),
    staticHistoryCommitMedianCadenceMs: percentile(intervals, 0.5),
  };
}

function compareEvents(left, right) {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.sequence - right.sequence;
}

function percentReduction(before, after) {
  return before <= 0 ? 0 : Number((100 * (before - after) / before).toFixed(2));
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function jsonBytes(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value));
}

function countBy(values, key) {
  const counts = new Map();
  for (const value of values) {
    const id = key(value);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Map(
    [...counts.entries()].sort((left, right) => right[1] - left[1]),
  );
}

function isInternalRuntimeMessage(entry) {
  if (entry.message?.visibility === 'internal') return true;
  return new Set([
    'runtime_context',
    'tool_image_observation',
    'task_plan_continuation',
    'empty_stop_recovery',
  ]).has(entry.message?.name);
}
