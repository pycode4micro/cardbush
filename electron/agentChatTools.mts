import { decodeRuntimeEvent, runtimeToolLifecycle, selectToolActivity, type RuntimeEvent, type RuntimeToolLifecycleEvent, type ToolExecutionRecord } from '@cardbush/bush-protocol';
import type { AgentHttpClient } from './agentHttpClient.mjs';
import { terminalText } from './agentChatPresentation.mjs';
import { readChatHistory } from './agentChatSessions.mjs';

export function isChatToolEvent(event: RuntimeEvent): event is RuntimeToolLifecycleEvent {
  return ['tool_queued', 'tool_running', 'tool_returned', 'tool_failed', 'tool_cancelled'].includes(event.kind);
}

type Activity = ReturnType<typeof runtimeToolLifecycle> & { cancellation?: string };
const pending = (tool: Activity) => tool.state === 'running' || tool.state === 'queued';

/** One group between visible transcript boundaries, backed by the same runtime
 * facts and stable parallel selection as the App. No arguments become titles. */
export class ChatToolActivity {
  #tools = new Map<string, Activity>();
  #group = new Set<string>();
  #selected?: string;
  get tools() { return [...this.#tools.values()]; }
  get count() { return this.#tools.size; }
  get failures() { return this.tools.filter(tool => tool.state === 'failed').length; }
  reset() { this.#tools.clear(); this.#group.clear(); this.#selected = undefined; }
  update(event: RuntimeToolLifecycleEvent) {
    const previous = this.#tools.get(event.payload.toolCallId);
    // Reconnection and late queued events cannot reopen a settled operation.
    if (previous && (!pending(previous) || previous.state === 'running' && event.kind === 'tool_queued')) return false;
    const tool: Activity = { ...runtimeToolLifecycle(event),
      ...(event.kind === 'tool_cancelled' ? { cancellation: event.payload.reason } : {}) };
    if (!event.payload.display && previous) { tool.title = previous.title; tool.summary = previous.summary; }
    this.#tools.set(tool.id, tool); this.#group.add(tool.id);
    const group = this.#entries();
    // A newly observed call can already be complete when events arrive in a batch.
    const preferred = !previous && !group.some(pending) ? undefined : this.#selected;
    this.#selected = selectToolActivity(group, preferred)?.id;
    return true;
  }
  #entries() { return [...this.#group].map(id => this.#tools.get(id)!); }
  current() {
    const tools = this.#entries(), selected = selectToolActivity(tools, this.#selected);
    if (!selected) return;
    return { selected, count: tools.length, pending: tools.filter(pending).length,
      failed: tools.filter(tool => tool.state === 'failed').length,
      cancelled: tools.filter(tool => tool.state === 'cancelled').length };
  }
  takeGroup() {
    const group = this.current(); this.#group.clear(); this.#selected = undefined; return group;
  }
}

/** Explicit inspection rereads durable events, including after CLI restart.
 * It never executes a tool or changes the ongoing task. */
export async function inspectChatTools(client: Pick<AgentHttpClient, 'call'>, io: { status(text: string): void },
  scope: { sessionId: string; turnId?: string }, argument: string, signal: AbortSignal) {
  const match = /^(?:([1-9]\d*)\s*)?(?:--turn\s+([1-9]\d*))?$/.exec(argument.trim());
  if (!match) { io.status('Usage: /tools [number] [--turn N]\n'); return; }
  const input = match[1] ?? '', sequence = match[2];
  if (sequence) {
    const turns = await readChatHistory(client, scope.sessionId, signal);
    const turn = turns.find(item => item.turnSequence === Number(sequence));
    if (!turn) { io.status(`No saved turn ${sequence} in this session.\n`); return; }
    scope = { sessionId: scope.sessionId, turnId: turn.turnId };
  }
  if (!scope.turnId) { io.status('No turn to inspect yet.\n'); return; }
  const events = await client.call('runtime.command', { kind: 'runtime.list_turn_events', payload: scope },
    AbortSignal.any([signal, AbortSignal.timeout(15_000)])) as unknown[];
  const activity = new ChatToolActivity();
  for (const value of events) {
    const event = decodeRuntimeEvent(value);
    if (event.sessionId === scope.sessionId && event.turnId === scope.turnId && isChatToolEvent(event)) activity.update(event);
  }
  const tools = activity.tools;
  if (!tools.length) { io.status('No tools in this turn yet.\n'); return; }
  const state = (tool: Activity) => tool.state === 'completed' ? 'Returned' : tool.state[0].toUpperCase() + tool.state.slice(1);
  const reason = (tool: Activity) => terminalText(tool.title).replace(/\s+/g, ' ').trim();
  if (!input) {
    io.status(`\nTools from ${sequence ? 'turn ' + sequence : 'this turn'}\n` + tools.map((tool, index) =>
      `  ${index + 1}. ${reason(tool)} · ${state(tool)}`).join('\n') + `\nUse /tools NUMBER${sequence ? ' --turn ' + sequence : ''} for details.\n`);
    return;
  }
  const tool = tools[Number(input) - 1];
  if (!tool) { io.status(`No tool ${input} in this turn. Use /tools to list them.\n`); return; }
  io.status(`\n${input}. ${reason(tool)}\nTool: ${tool.name}\nStatus: ${state(tool)}\n` +
    (tool.error ? `${tool.error.code}: ${tool.error.message}\n` +
      (tool.error.details && Object.keys(tool.error.details).length ? JSON.stringify(tool.error.details, null, 2) + '\n' : '') : '') +
    (tool.cancellation ? `Cancellation: ${tool.cancellation}\n` : ''));
  const execution = await client.call('runtime.command', { kind: 'runtime.get_tool_execution',
    payload: { ...scope, toolCallId: tool.id } }, AbortSignal.any([signal, AbortSignal.timeout(15_000)])) as ToolExecutionRecord | null;
  if (execution?.sessionId === scope.sessionId && execution.turnId === scope.turnId && execution.toolCall.id === tool.id) {
    io.status(terminalText('Arguments:\n' + execution.toolCall.argumentsText + '\n' +
      (execution.result === undefined ? '' : 'Result:\n' + (typeof execution.result === 'string' ? execution.result : JSON.stringify(execution.result, null, 2)) + '\n')));
  }
}
