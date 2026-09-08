// Read-only replay through the real Electron event adapter and transcript modules.
// Usage: node scripts/replay-chat-transcript.mjs <event-journal.jsonl> [...] [--session <session-journal.jsonl>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadChatTranscript, transcriptDirectory, transcriptModules } from './helpers/load-chat-transcript.mjs';

let events = [];
const listeners = new Set();
const bridge = {
  onStreamFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async startStream({ protocol, subscriptionId }) {
    for (const event of events) {
      for (const listener of listeners) listener({ protocol, type: 'stream_frame', subscriptionId, frame: { kind: 'event', event } });
    }
    for (const listener of listeners) listener({ protocol, type: 'stream_frame', subscriptionId, frame: { kind: 'end' } });
  },
  async command({ protocol, operationId, command }) {
    if (!['runtime.get_tool_execution', 'runtime.get_session'].includes(command.kind)) {
      throw new Error(`Replay must not perform command: ${command.kind}`);
    }
    return { protocol, type: 'command_response', operationId, ok: true, result: null };
  },
  async stopStream() {}, async cancelOperation() {},
};
const api = await loadChatTranscript({
  source: [
    ...transcriptModules.map(name => `export * from ${JSON.stringify(path.join(transcriptDirectory, name + '.ts'))};`),
    `export { streamRuntimeTurnEvents } from ${JSON.stringify(path.resolve('src/backend/runtimeChat.ts'))};`,
    `export { projectRuntimeTurnMessages } from ${JSON.stringify(path.resolve('src/backend/runtimeSessionMessageProjection.ts'))};`,
    `export { coalesceAssistantTranscript } from ${JSON.stringify(path.resolve('src/features/chatMessages/assistantTranscriptPresentation.ts'))};`,
  ].join('\n'),
  globals: { console, AbortController, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, process: { env: { NODE_ENV: 'test' } },
    window: { setTimeout, clearTimeout, cardbushDesktop: { runtime: bridge } } },
});

const paths = process.argv.slice(2);
const sessionFlag = paths.indexOf('--session');
const sessionJournal = sessionFlag >= 0 ? paths.splice(sessionFlag, 2)[1] : undefined;
const commits = sessionJournal ? (await fs.readFile(sessionJournal, 'utf8')).split('\n').filter(line => line.trim())
  .map(line => { const record = JSON.parse(line); return record.event ?? record; }).filter(event => event.kind === 'turn_committed') : [];
if (!paths.length) throw new Error('Provide one or more event journal paths.');
for (const journal of paths) {
  // Never call the writable persistence loader on a live journal.
  const lines = (await fs.readFile(journal, 'utf8')).split('\n');
  events = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { const record = JSON.parse(line); return [record.event ?? record]; }
    catch (error) { if (index === lines.length - 1) return []; throw error; }
  });
  const { sessionId, turnId } = events[0];
  const assistantId = 'replay-placeholder';
  let state = { [sessionId]: [{ id: assistantId, role: 'assistant', content: '', turnId }] };
  const pending = [];
  const chunks = api.createSegmentedAssistantStreamBuffers((delta, route, release) => {
    state = api.appendAssistantDelta(state, sessionId, assistantId, delta, route, release);
  }, { shouldAnimate: () => false });
  await api.streamRuntimeTurnEvents({ sessionId, turnId,
    onDelta: (delta, route) => chunks.push(delta, route),
    onAssistantSegmentCompleted: (content, route) => { pending.push(chunks.completeSegment(content, route)); },
    onToolExecution: execution => {
      pending.push(chunks.releaseToolBoundary().then(() => {
        state = api.appendToolExecution(state, sessionId, assistantId, execution);
      }));
    },
  });
  await chunks.releaseTerminal();
  await Promise.all(pending);
  chunks.dispose();
  const identity = message => message.assistantMessageId ?? message.messageId ?? message.id;
  const expectedText = new Map();
  const expectedTools = new Map();
  const expectedOrder = new Set();
  for (const event of events) {
    if (event.kind === 'assistant_segment_started') expectedOrder.add(event.payload.messageId);
    if (event.kind === 'assistant_segment_completed') {
      const { messageId, content } = event.payload;
      expectedText.set(messageId, (expectedText.get(messageId) ?? '') + content);
    }
    if (event.kind === 'tool_queued') {
      expectedTools.set(event.payload.toolCallId, event.payload.assistantMessageId);
      expectedOrder.add(event.payload.assistantMessageId);
    }
  }
  const inspect = stage => {
    const projected = api.normalizeActiveTurnTranscriptForDisplay(api.normalizeChatMessagesForDisplay(state[sessionId]), stage === 'live' ? turnId : '');
    const visible = projected.flatMap(message => [...(message.loopHistory ?? []), message]).filter(message => message.role === 'assistant');
    const missingText = [...expectedText].filter(([id, content]) => !visible.some(message => identity(message) === id && message.content === content));
    const misplacedTools = [...expectedTools].filter(([id, owner]) => !visible.some(message => identity(message) === owner && message.toolExecutions?.some(tool => tool.id === id)));
    const missingTools = [...expectedTools].filter(([id]) => !visible.some(message => message.toolExecutions?.some(tool => tool.id === id)));
    const duplicateKeys = visible.map(message => message.id).filter((id, index, ids) => ids.indexOf(id) !== index);
    const toolIds = visible.flatMap(message => message.toolExecutions ?? []).map(tool => tool.id).filter(id => expectedTools.has(id));
    const duplicateToolCount = toolIds.length - new Set(toolIds).size;
    const actualOrder = visible.map(identity).filter(id => expectedOrder.has(id));
    const orderMatches = JSON.stringify(actualOrder) === JSON.stringify([...expectedOrder]);
    const packages = api.coalesceAssistantTranscript(visible);
    const packageText = packages.filter(message => message.content.trim()).map(message => [identity(message), message.content]);
    const originalText = visible.filter(message => message.content.trim()).map(message => [identity(message), message.content]);
    const packageTools = packages.flatMap(message => message.toolExecutions ?? []).map(tool => [tool.id, tool.assistantMessageId]);
    const originalTools = visible.flatMap(message => message.toolExecutions ?? []).map(tool => [tool.id, tool.assistantMessageId]);
    const packageContentMatches = JSON.stringify(packageText) === JSON.stringify(originalText) && JSON.stringify(packageTools) === JSON.stringify(originalTools);
    console.log(JSON.stringify({ stage, turnId, eventCount: events.length, assistantTexts: expectedText.size, toolCalls: expectedTools.size,
      visibleSegments: visible.length, missingTextIds: missingText.map(([id]) => id), misplacedToolCount: misplacedTools.length,
      missingToolCount: missingTools.length, duplicateToolCount, duplicateKeys, orderMatches,
      presentationSegments: packages.length, packageContentMatches }));
    if (missingText.length || misplacedTools.length || duplicateKeys.length || duplicateToolCount || !orderMatches || !packageContentMatches) process.exitCode = 1;
  };
  inspect('live');
  const committed = commits.find(event => event.payload.turnId === turnId)?.payload;
  if (committed) {
    state = api.mergeFinalStreamMessages(state, sessionId, api.projectRuntimeTurnMessages(committed, sessionId), {
      turnId, temporaryMessageIds: [assistantId], toolSourceMessageId: assistantId,
    });
    inspect('committed');
  }
}
