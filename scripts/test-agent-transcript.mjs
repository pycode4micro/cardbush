import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ToolExecutionStore } from '../packages/bush-runtime/dist/index.js';
import { decodeRuntimeEvent, decodeSessionSnapshot } from '../packages/bush-protocol/dist/index.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

// Exercise the shipped local consumer and remote transport, never a second
// transcript implementation or a string match against component source.
const now = '2026-09-22T09:00:00.000Z', sessionId = 's', turnId = 't';
const plain = value => JSON.parse(JSON.stringify(value));
const flatten = messages => messages.flatMap(message => [...flatten(message.loopHistory ?? []), { ...message, loopHistory: undefined }]);
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
let fixture;
const commands = [];
const read = command => {
  commands.push(command);
  if (command.kind === 'runtime.get_session') return fixture.snapshot ?? null;
  if (command.kind === 'runtime.get_tool_execution') return fixture.records?.find(r => r.toolCall.id === command.payload.toolCallId) ?? null;
  if (command.kind === 'runtime.get_user_message') return fixture.guidance?.find(m => m.messageId === command.payload.messageId) ?? null;
  throw Error(`Unexpected command: ${command.kind}`);
};
const listeners = new Set();
const bridge = {
  onStreamFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async startStream({ protocol, subscriptionId }) {
    const emit = frame => { for (const listener of listeners) listener({ protocol, type: 'stream_frame', subscriptionId, frame }); };
    for (const event of fixture.events) emit({ kind: 'event', event });
    emit({ kind: 'end' });
  },
  async command({ protocol, operationId, command }) { return { protocol, type: 'command_response', operationId, ok: true, result: read(command) }; },
  async stopStream() {}, async cancelOperation() {},
};
const api = await loadChatTranscript({ source: [
  ['src/backend/runtimeChat.ts', 'streamRuntimeTurnEvents'],
  ['src/backend/runtimeSessionMessageProjection.ts', 'projectRuntimeTurnMessages'],
  ['src/features/agents/agentConversationBackend.ts', 'createAgentConversationBackend, agentRuntimeClient'],
  ['src/features/chatMessages/transcript/liveMessageUpdates.ts', 'appendAssistantDelta, appendToolExecution, applyTaskPlanUpdate, applyAssistantSegmentBoundary, applyAssistantRevision, applyTurnTerminalSnapshot'],
  ['src/features/chatMessages/transcript/assistantStreamBuffer.ts', 'createSegmentedAssistantStreamBuffers'],
  ['src/features/chatMessages/transcript/messageProjection.ts', 'mergeFinalStreamMessages, mergeLoadedMessagesPreservingLocalState, normalizeChatMessagesForDisplay'],
].map(([file, names]) => `export { ${names} } from ${JSON.stringify(path.resolve(file))};`).join('\n'),
  globals: { console, AbortController, DOMException, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, sessionStorage: storage(),
    process: { env: { NODE_ENV: 'test' } }, window: { setTimeout, clearTimeout, cardbushDesktop: { runtime: bridge } } },
});
const event = (sequence, kind, payload) => decodeRuntimeEvent({ protocol: 'bush.runtime_event.v1', requestId: 'request', sessionId, turnId,
  eventId: `e${sequence}`, sequence, createdAt: new Date(Date.parse(now) + sequence * 1000).toISOString(), kind, payload });
const text = (n, messageId, content, segmentId = messageId, ordinal = 1) => event(n, 'assistant_segment_completed', { messageId, segmentId, ordinal, content });
const tool = (n, assistantMessageId, toolCallId, kind = 'tool_returned', toolName = 'terminal_exec') => event(n, kind, { assistantMessageId, toolCallId, ordinal: 0, toolName });
const remoteCall = async (op, input) => op === 'sessions.get' ? fixture.snapshot ?? null : op === 'chat.jobs' ? [] : op === 'runtime.command' ? read(input) : assert.fail(`Unexpected service operation ${op}`);
const watch = (_request, listener) => { for (const event of fixture.events) listener({ type: 'event', event }); listener({ type: 'end' }); return () => {}; };
async function project(events, mode = 'remote', extra = {}) {
  fixture = { events, ...extra };
  const fallback = 'active';
  let state = { s: [{ id: fallback, conversationId: sessionId, turnId, role: 'assistant', content: '', createdAt: now }] };
  const observations = { plans: [], thinking: [], recovery: [], usage: [], permissions: [], terminals: [] };
  let finalSnapshotPromise;
  const buffers = api.createSegmentedAssistantStreamBuffers((delta, route, release) => {
    state = api.appendAssistantDelta(state, sessionId, fallback, delta, route, release);
  }, { shouldAnimate: () => false });
  const handlers = { sessionId, turnId,
    onDelta: (delta, route) => buffers.push(delta, route),
    onAssistantSegmentCompleted: (content, route) => buffers.completeSegment(content, route),
    onToolExecution: execution => { buffers.flushToolBoundary(); state = api.appendToolExecution(state, sessionId, fallback, execution); },
    onTaskPlanUpdate: update => { observations.plans.push(update); state = api.applyTaskPlanUpdate(state, sessionId, fallback, update); },
    onExecution: update => { if (update.guidanceMessageId) { buffers.flushToolBoundary(); state = api.applyAssistantSegmentBoundary(state, sessionId, fallback, update); } },
    onAssistantRevision: revision => { buffers.flushToolBoundary(); state = api.applyAssistantRevision(state, sessionId, fallback, revision); },
    onThinking: update => observations.thinking.push(update), onConnectionState: update => observations.recovery.push(update),
    onContextWindowUsage: update => observations.usage.push(update), onInteractiveRequest: update => observations.permissions.push(update),
    onDone: update => { observations.terminals.push(update); state = api.applyTurnTerminalSnapshot(state, sessionId, fallback, update); },
    onMessages: (messages, finalSnapshot) => {
      assert.equal(finalSnapshot, true);
      finalSnapshotPromise = buffers.releaseTerminal().then(() => {
        state = api.mergeFinalStreamMessages(state, sessionId, messages, { turnId, temporaryMessageIds: [fallback], toolSourceMessageId: fallback });
      });
    },
  };
  if (mode === 'local') await api.streamRuntimeTurnEvents(handlers);
  else await api.createAgentConversationBackend(remoteCall, 'remote', watch).backend.streamTurnEvents(handlers);
  await finalSnapshotPromise;
  await buffers.flushAllStreaming(); buffers.dispose();
  return { rows: plain(flatten(state.s)), messages: plain(state.s), observations: plain(observations) };
}
const assistants = result => result.rows.filter(row => row.role === 'assistant');

test('local and remote preserve the same plan, compaction, provider retry, thinking and usage', async () => {
  const plan = { protocol: 'bush.plan_state.v1', sessionId, revision: 1, updatedAt: now,
    plan: { protocol: 'bush.task_plan.v1', plan_id: 'plan', session_id: sessionId, active: true,
      explanation: 'Parity', nodes: [{ id: 'step', step: 'Inspect result', status: 'in_progress' }] } };
  const store = new ToolExecutionStore({ now: () => now });
  const receipt = store.record({ protocol: 'bush.tool_call.v1', id: 'plan-tool', name: 'update_task_plan', argumentsText: '{}' },
    { requestId: 'request', sessionId, turnId, round: 1, ordinal: 0 }, { kind: 'returned', result: plan, workspaceChanges: [] });
  const compaction = { compactionId: 'c', round: 1, attempt: 1, assistantMessageId: 'm1' };
  const events = [text(1, 'm1', 'Prepare'), tool(2, 'm1', 'plan-tool', 'tool_returned', 'update_task_plan'),
    event(3, 'context_compaction_started', { ...compaction, thresholdRatio: .8, triggerRatio: .8, estimatedInputTokens: 800, usableInputTokens: 1000, measurement: 'provider', precedingTurnCount: 1, activeTurnIncluded: true }),
    event(4, 'context_compaction_completed', { ...compaction, summarizedTurnCount: 1, activeTurnCheckpointed: true }),
    event(5, 'provider_retry', { attempt: 1, maxAttempts: null, nextRetryMs: 3000, code: 'ECONNRESET', message: 'reset' }),
    event(6, 'reasoning_segment_delta', { messageId: 'r1', segmentId: 'reasoning', ordinal: 0, delta: 'Think' }),
    event(7, 'model_request_usage', { model: 'fixture', round: 1, attempt: 1, contextWindowTokens: 10000, inputTokens: 1000 })];
  const before = JSON.stringify({ events, receipt });
  const local = await project(events, 'local', { records: [receipt] });
  const remote = await project(events, 'remote', { records: [receipt] });
  assert.deepEqual(remote, local);
  assert.equal(remote.observations.plans.length, 1);
  assert.equal(assistants(remote).flatMap(row => row.toolExecutions ?? []).filter(tool => tool.name === 'runtime_context_compaction').length, 1);
  assert.deepEqual(remote.observations.recovery.map(update => update.state), ['retrying', 'recovered']);
  assert.equal(remote.observations.thinking[0].delta, 'Think');
  assert.equal(remote.observations.usage.length, 1);
  assert.equal(JSON.stringify({ events, receipt }), before, 'presentation never rewrites the journal');
});

test('interleaved remote narration retains parallel tool ownership (2 / 3 / 2 / 2)', async () => {
  let n = 0; const events = [];
  [2, 3, 2, 2].forEach((count, round) => { events.push(text(++n, `m${round}`, `narration ${round}`));
    for (let i = 0; i < count; i++) events.push(tool(++n, `m${round}`, `t${round}-${i}`)); });
  const rows = assistants(await project(events));
  assert.deepEqual(rows.map(row => row.toolExecutions?.length), [2, 3, 2, 2]);
  for (const row of rows) for (const tool of row.toolExecutions) assert.equal(tool.assistantMessageId, row.messageId);
});

test('content block ordinals reset per response; late tool completions retain original owners', async () => {
  const events = [event(1, 'assistant_segment_delta', { messageId: 'm1', segmentId: 's1', ordinal: 1, delta: 'first' }),
    text(2, 'm1', 'first', 's1'), text(3, 'm1', ' second', 's2', 3), tool(4, 'm1', 'a', 'tool_queued'),
    tool(5, 'm2', 'b', 'tool_running'), text(6, 'm3', 'next'), tool(7, 'm1', 'a'), tool(8, 'm2', 'b')];
  const rows = assistants(await project(events));
  assert.deepEqual(rows.map(row => [row.messageId, row.content]), [['m1', 'first second'], ['m2', ''], ['m3', 'next']]);
  assert.equal(rows[0].toolExecutions[0].sequence, 4); assert.equal(rows[1].toolExecutions[0].sequence, 5);
});

test('applied guidance is restored from durable facts at the correct boundary without local storage', async () => {
  const events = [text(1, 'm1', 'before'), tool(2, 'm1', 'a'), event(3, 'guidance_applied', { messageId: 'g1', previousAssistantMessageId: 'm1', queueDepth: 0, afterRound: 1 }), text(4, 'm2', 'after'), tool(5, 'm2', 'b')];
  const guidance = [{ messageId: 'g1', createdAt: now, message: { role: 'user', name: 'turn_guidance', content: 'change direction' } }];
  const remote = await project(events, 'remote', { guidance });
  assert.deepEqual(remote, await project(events, 'local', { guidance }));
  assert.deepEqual(remote.rows.map(row => row.content), ['before', 'change direction', 'after']);
  assert.equal(remote.rows[1].metadata.guidance_delivery, 'sent');
  assert.equal(remote.rows[0].toolExecutions[0].id, 'a'); assert.equal(remote.rows[2].toolExecutions[0].id, 'b');
});

test('terminal failure preserves partial narration and tools', async () => {
  const result = await project([text(1, 'm1', 'partial'), tool(2, 'm1', 'a'), event(3, 'turn_terminal', { status: 'failed', reason: 'provider_error', details: {} })]);
  assert.equal(result.observations.terminals[0].status, 'failed');
  assert.equal(assistants(result)[0].content, 'partial'); assert.equal(assistants(result)[0].toolExecutions[0].id, 'a');
});

test('remote SSE reconnect retains the cursor, suppresses duplicate delivery and never resends work', async () => {
  const requests = [], states = []; let closed = 0;
  const first = text(1, 'm1', 'first'), second = text(2, 'm2', 'second');
  const client = api.agentRuntimeClient(() => assert.fail('Reconnect cannot issue commands'), (request, listener) => {
    requests.push(plain(request));
    if (requests.length === 1) { listener({ type: 'event', event: first }); listener({ type: 'error', error: 'connection reset' }); }
    else { listener({ type: 'event', event: first }); listener({ type: 'event', event: second }); listener({ type: 'end' }); }
    return () => { closed++; };
  });
  const events = [];
  for await (const event of client.events({ sessionId, turnId, onTransportState: state => states.push(state.state) })) events.push(event.sequence);
  assert.deepEqual(events, [1, 2]); assert.equal(requests[1].afterSequence, 1); assert.equal(closed, 2);
  assert.deepEqual(states, ['retrying', 'recovered']);
});

test('same permission identity on two hosts answers only the selected Runtime', async () => {
  const answered = [];
  const a = api.createAgentConversationBackend(async (op, input) => { answered.push(['a', op, input]); }, 'a', watch);
  const b = api.createAgentConversationBackend(async (op, input) => { answered.push(['b', op, input]); }, 'b', watch);
  const request = { permissionId: 'same', sessionId, turnId, request: { reason: 'Read', actions: ['read'], targets: [{ kind: 'filesystem_path', value: '/srv/private' }], requestedCapabilityIds: ['filesystem.read'] } };
  for (const host of [a, b]) host.runtime.interactions.registerRuntimePermission({ ...request, answer: host.runtime.answerPermission });
  await a.backend.replyInteraction({ interactionId: 'same', answers: [{ questionId: 'permission', selectedOptionId: 'allow_once' }] });
  assert.equal(answered.length, 1); assert.equal(answered[0][0], 'a');
  assert.equal(a.runtime.interactions.pendingRuntimeInteraction(sessionId), null);
  assert.equal(b.runtime.interactions.pendingRuntimeInteraction(sessionId).id, 'same');
});

const outputLimitSnapshot = () => decodeSessionSnapshot({
  protocol: 'bush.session_snapshot.v1', sessionId, revision: 1, createdAt: now, updatedAt: now, supersededMessageIds: [],
  turns: [{ turnId, turnSequence: 1, createdAt: now, completedAt: '2026-09-22T09:00:08.000Z',
    status: 'failed', reason: 'model_output_limit_exceeded', messages: [
      { role: 'user', content: 'Create the presentation' },
      { role: 'assistant', content: 'Dependencies installed' },
      { role: 'developer', name: 'output_limit_continuation', content: 'Continue without repeating completed work' },
      { role: 'assistant', content: 'Continue writing the slides' },
      { role: 'developer', name: 'output_limit_continuation', content: 'Continue without repeating completed work' },
      { role: 'assistant', content: '', toolCalls: [] },
    ].map((message, messageIndex) => ({ messageId: ['u1', 'm1', 'd1', 'm2', 'd2', 'm3'][messageIndex],
      turnId, turnSequence: 1, messageIndex, createdAt: now, message })) }],
});

test('local and remote final history sync retain output-limit details, including an empty last response', async () => {
  const details = { round: 10, continuationAttempts: 2, maxOutputTokens: 8192, outputTokens: 8192, hadHiddenReasoning: true };
  const events = [text(1, 'm1', 'Dependencies installed'), tool(2, 'm1', 'a'),
    text(3, 'm2', 'Continue writing the slides'), event(8, 'turn_terminal', { status: 'failed', reason: 'model_output_limit_exceeded', details })];
  const snapshot = outputLimitSnapshot();
  const before = JSON.stringify({ events, snapshot });
  const local = await project(events, 'local', { snapshot });
  const remote = await project(events, 'remote', { snapshot });
  assert.deepEqual(remote, local);
  const final = assistants(remote).at(-1);
  assert.equal(final.status, 'failed');
  assert.equal(final.metadata.stop_reason, 'model_output_limit_exceeded');
  assert.deepEqual(final.metadata.stop_details, details);
  assert.equal(final.metadata.terminal_event_sequence, 8);
  assert.equal(final.metadata.cardbush_terminal_snapshot, true);
  assert.equal(remote.rows.some(row => row.role === 'system'), false);
  const displayed = flatten(api.normalizeChatMessagesForDisplay(remote.messages));
  assert.equal(displayed.flatMap(row => row.toolExecutions ?? []).filter(item => item.id === 'a').length, 1);
  const reloaded = api.mergeLoadedMessagesPreservingLocalState(remote.messages, api.projectRuntimeTurnMessages(snapshot.turns[0], sessionId));
  assert.deepEqual(plain(api.normalizeChatMessagesForDisplay(reloaded).at(-1).metadata.stop_details), details);
  assert.equal(JSON.stringify({ events, snapshot }), before, 'display recovery never changes the model journal or its cache prefix');
});

test('cold history reads restore failure reasons and preserve the distinct stopped/completed states', () => {
  for (const [status, reason] of [['failed', 'model_output_limit_exceeded'], ['failed', 'provider_tool_call_incomplete'], ['stopped', 'user_cancelled'], ['completed', 'completed']]) {
    const turn = { ...outputLimitSnapshot().turns[0], status, reason };
    const before = JSON.stringify(turn);
    const messages = api.normalizeChatMessagesForDisplay(api.projectRuntimeTurnMessages(turn, sessionId));
    const final = messages.at(-1);
    assert.equal(final.role, 'assistant');
    assert.equal(final.status, status);
    assert.equal(final.metadata.stop_reason, reason);
    assert.equal(final.metadata.stopped, status === 'stopped');
    assert.equal(JSON.stringify(turn), before);
  }
});

test('final history sync does not transfer a failed active turn into older completed turns', () => {
  const turn = outputLimitSnapshot().turns[0];
  const current = api.applyTurnTerminalSnapshot({ s: [{ id: 'active', role: 'assistant', turnId, content: '', createdAt: now }] }, sessionId, 'active',
    { turnId, status: 'failed', stopped: false, stopReason: turn.reason, stopDetails: { continuationAttempts: 2 }, completedAt: now });
  const older = { id: 'older-assistant', messageId: 'older-assistant', turnId: 'older', role: 'assistant', status: 'completed', content: 'Already done', createdAt: now };
  const merged = api.mergeFinalStreamMessages(current, sessionId, [older, ...api.projectRuntimeTurnMessages(turn, sessionId)],
    { turnId, temporaryMessageIds: ['active'] });
  const previous = merged.s.find(row => row.id === older.id);
  assert.equal(previous.status, 'completed');
  assert.equal(previous.metadata?.stop_reason, undefined);
  assert.equal(previous.metadata?.stop_details, undefined);
});

test('unconfirmed guidance survives remount with its exact append identity and body', async () => {
  const received = [];
  const call = async (operation, input) => {
    if (operation === 'sessions.get') return null;
    if (operation === 'chat.jobs') return [];
    if (operation === 'runtime.command' && input.kind === 'runtime.get_user_message') return null;
    assert.equal(operation, 'runtime.command'); assert.equal(input.kind, 'runtime.enqueue_guidance');
    received.push(plain(input));
    if (received.length === 1) throw Error('acknowledgement lost');
    return { ...input.payload, accepted: true, queueDepth: 1 };
  };
  const request = { sessionId, turnId, clientMessageId: 'restore-guidance', guidance: '保留原来的约束', createdAt: now };
  const first = api.createAgentConversationBackend(call, 'guidance-remount', watch);
  await assert.rejects(first.backend.sendGuidance(request), /acknowledgement lost/);
  assert.equal(received[0].payload.content, request.guidance);
  assert.equal(received[0].payload.metadata.userTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(received[0].payload.metadata.timeContext.includes(now));
  const restored = api.createAgentConversationBackend(call, 'guidance-remount', watch);
  const loaded = await restored.backend.fetchSessionMessages(sessionId);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].content, request.guidance);
  assert.equal(loaded.messages[0].metadata.guidance_delivery, 'failed');
  assert.equal(loaded.messages[0].createdAt, now);
  await restored.backend.sendGuidance({ ...request, createdAt: '2026-09-22T10:00:00.000Z' });
  assert.deepEqual(received[1], received[0], 'retry must not regenerate the timestamp, identity or resolved context');
  const queued = (await restored.backend.fetchSessionMessages(sessionId)).messages[0];
  assert.equal(queued.status, 'pending'); assert.equal(queued.metadata.guidance_delivery, 'queued');
  assert.equal((await restored.backend.fetchSessionMessages('another-session')).messages.length, 0);
  const other = api.createAgentConversationBackend(call, 'another-host', watch);
  assert.equal((await other.backend.fetchSessionMessages(sessionId)).messages.length, 0);
});

test('service admission failures remain visible even when no Runtime turn was created', async () => {
  const completed = [], received = [];
  const call = async (operation, input) => {
    received.push([operation, input]);
    if (operation === 'sessions.get') return null;
    if (operation === 'chat.jobs') return [{ id: 'failed-admission', sessionId, turnId, status: 'failed', error: 'Unknown model: missing', completedAt: now }];
    assert.fail(`Unexpected operation ${operation}`);
  };
  const remote = api.createAgentConversationBackend(call, 'admission', (_request, listener) => { listener({ type: 'end' }); return () => {}; });
  await remote.backend.streamTurnEvents({ sessionId, turnId, onDelta() {}, onDone: fact => completed.push(plain(fact)) });
  assert.equal(completed.length, 1); assert.equal(completed[0].status, 'failed');
  assert.equal(completed[0].stopReason, 'Unknown model: missing');
  assert.equal(completed[0].raw.source, 'agent_service_job');
  assert.equal(received.some(([operation]) => operation === 'chat.send'), false);
});

test('vision input is opt-in and requires the remote capability, including on enhanced older services', async () => {
  for (const available of [undefined, false, true]) for (const enabled of [false, true]) {
    const received = [];
    const call = async (operation, input) => {
      if (operation === 'sessions.get') return null;
      assert.equal(operation, 'chat.send');
      const wire = plain(input);
      if (!available) assert.equal('visionEnabled' in wire, false, 'strict old schemas reject even visionEnabled: false');
      received.push(wire);
      return { id: input.requestId, sessionId, turnId, status: 'queued', createdAt: now };
    };
    const remote = api.createAgentConversationBackend(call, `vision-${available}-${enabled}`, watch, { enhanced: true, visualInputAvailable: available });
    await remote.backend.queue.enqueue({ sessionId, userInput: '查看图片', model: 'fixture', referencePlanMode: 'off', standardImageInputEnabled: enabled });
    assert.equal(received.length, 1);
    assert.equal(received[0].visionEnabled, available && enabled ? true : undefined);
  }
});

test('changing vision affects new submissions but preserves an unconfirmed request exactly', async () => {
  const received = [];
  const call = async (operation, input) => {
    if (operation === 'sessions.get') return null;
    assert.equal(operation, 'chat.send'); received.push(plain(input));
    if (received.length === 1) throw Error('acknowledgement lost');
    return { id: input.requestId, sessionId, turnId, status: 'queued', createdAt: now };
  };
  const request = { sessionId, userInput: '查看图片', model: 'fixture', standardImageInputEnabled: true, images: [{ path: '/srv/picture.png' }] };
  const first = api.createAgentConversationBackend(call, 'vision-retry', watch, { visualInputAvailable: true });
  await assert.rejects(first.backend.queue.enqueue(request), /acknowledgement lost/);
  const restored = api.createAgentConversationBackend(call, 'vision-retry', watch, { visualInputAvailable: true });
  await restored.backend.queue.enqueue({ ...request, standardImageInputEnabled: false, images: [], files: ['/srv/picture.png'] });
  assert.deepEqual(received[1], received[0], 'retry cannot rewrite the accepted payload or its request ID');
  assert.equal(received[1].visionEnabled, true);
  assert.equal(received[1].userMessageMetadata.userTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  await restored.backend.queue.enqueue({ ...request, userInput: '下一条消息', standardImageInputEnabled: false, images: [], files: ['/srv/picture.png'] });
  assert.notEqual(received[2].requestId, received[0].requestId);
  assert.equal('visionEnabled' in received[2], false);
  assert.equal('images' in received[2], false);
  assert.deepEqual(received[2].files, ['/srv/picture.png']);
});
