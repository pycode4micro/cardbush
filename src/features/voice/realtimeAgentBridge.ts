import type { VoiceTarget } from './voiceSession';
import type { RealtimeToolCall } from '../../../electron/realtimeVoiceTypes';
import type { SubagentTask } from '@cardbush/bush-protocol';
import { realtimeAgentError } from './realtimeAgentError';

export interface RealtimeAgentExecutor {
  summarize?(taskId: string, language: 'zh' | 'en', signal?: AbortSignal): Promise<string>;
  pin?(target: VoiceTarget): Promise<VoiceTarget>;
  record?(entry: import('@cardbush/bush-protocol').ConversationEntry): Promise<void>;
  pageWrite?(id: string, content: string): Promise<void>;
  prepareConversation?(): Promise<string>;
  compact?(job: import('@cardbush/bush-protocol').RealtimeContextJob, signal?: AbortSignal): Promise<import('@cardbush/bush-protocol').RealtimeContextResult>;
  execute(callId: string, action: 'subagent' | 'send_subagent_message' | 'read_subagent_conversation', args: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(): Promise<SubagentTask[]>;
}

/** Tool calls acknowledge work; a separate observer delivers terminal facts. */
export class RealtimeAgentBridge {
  private target?: VoiceTarget;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private watching = new Set<string>();
  private announced = new Set<string>();
  private delivered = new Set<string>();
  private delivering = new Map<string, Promise<void>>();
  private calls = new Map<string, { signature: string; result: Promise<string> }>();
  private preparing = 0;
  private polling = false;
  private callTasks = new Map<string, string>();
  constructor(private submitting: (value: boolean) => void,
    private notify: (result: Record<string, unknown>) => Promise<void> = async () => {},
    private activity: (running: number) => void = () => {}, private pollMs = 1500,
    private reportError: (message: string) => void = () => {}) {}
  update(target: VoiceTarget) { this.target = target; this.schedule(); }
  private schedule() {
    if (!this.closed && !this.timer && this.target?.agent && this.target.sessionId)
      this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, this.pollMs);
  }
  async run(call: RealtimeToolCall): Promise<string> {
    const signature = JSON.stringify([call.name, call.arguments]);
    const previous = this.calls.get(call.id);
    if (previous) return previous.signature === signature ? previous.result : JSON.stringify({ status: 'rejected', message: 'Call ID reused with different arguments.' });
    const result = this.execute(call).catch(error => {
      const failure = realtimeAgentError(error);
      this.reportError(`${failure.message} (${failure.code})`);
      return JSON.stringify(failure);
    });
    this.calls.set(call.id, { signature, result });
    return result;
  }
  private async execute(call: RealtimeToolCall) {
    if (this.closed) return JSON.stringify({ status: 'detached' });
    const agent = this.target?.agent;
    if (!agent || this.target?.environment !== 'local') throw Object.assign(Error('This call requires a configured local Agent.'), { code: 'realtime_local_agent_required' });
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid arguments.');
    const allowed: Record<string, string[]> = { subagent: ['prompt'], await_subagent: ['task_ids'], send_subagent_message: ['task_id','prompt'], read_subagent_conversation: ['task_id','cursor'], ...(this.target?.assistant ? { page_write: ['content'] } : {}) };
    if (!allowed[call.name] || Object.keys(args).some(key => !allowed[call.name].includes(key))) throw Error('Unknown voice tool or arguments.');
    if (call.name === 'page_write') {
      if (!agent.pageWrite || typeof args.content !== 'string' || !args.content.trim() || args.content.length > 64000) throw Error('Invalid page content.');
      await agent.pageWrite(call.id, args.content);
      return JSON.stringify({ status: 'written' });
    }
    if (call.name === 'await_subagent') {
      if (args.task_ids !== undefined && (!Array.isArray(args.task_ids) || args.task_ids.length > 8 || args.task_ids.some(id => typeof id !== 'string' || !id))) throw Error('Invalid task_ids.');
      this.submitting(true);
      let tasks: SubagentTask[];
      try { tasks = await agent.list(); } finally { this.submitting(this.preparing > 0); }
      const ids = args.task_ids as string[] | undefined;
      if (ids?.some(id => !tasks.some(task => task.taskId === id))) throw Error('Task does not belong to this conversation.');
      const selected = (ids?.length ? tasks.filter(task => ids.includes(task.taskId)) : tasks.filter(task => this.watching.has(task.taskId) || task.parentTurnId.startsWith('voice_turn_'))).slice(-8);
      for (const task of selected) { this.watching.add(task.taskId); if (task.status !== 'running') this.delivered.add(task.taskId); }
      return JSON.stringify({ status: selected.some(task => task.status === 'running') ? 'watching' : 'settled',
        tasks: selected.slice(-8).map(task => this.summary(task, 600)), notification: 'Running tasks will report automatically. Continue talking; do not poll or wait silently.' });
    }
    if (call.name !== 'read_subagent_conversation' && (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 8000)) throw Error('Provide a prompt (1–8000 characters).');
    if (call.name !== 'subagent' && (typeof args.task_id !== 'string' || !args.task_id)) throw Error('Provide task_id.');
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^\d+:\d+$/.test(args.cursor))) throw Error('Invalid cursor.');
    this.preparing++; this.submitting(true);
    try {
      const result = await agent.execute(call.id, call.name as 'subagent' | 'send_subagent_message' | 'read_subagent_conversation', args);
      if (call.name !== 'read_subagent_conversation') this.reportError('');
      if (typeof result.taskId === 'string' && call.name !== 'read_subagent_conversation') { this.watching.add(result.taskId); this.callTasks.set(call.id, result.taskId); this.delivered.delete(result.taskId); }
      this.schedule(); return JSON.stringify(result);
    } finally { this.preparing--; this.submitting(this.preparing > 0); }
  }
  /** Do not push a fast completion before its initial tool receipt reaches the provider. */
  acknowledge(calls: RealtimeToolCall[]) { for (const call of calls) { const id = this.callTasks.get(call.id); if (id) this.announced.add(id); } }
  private summary(task: SubagentTask, maxChars = 5000) {
    return { taskId: task.taskId, childSessionId: task.childSessionId, status: task.status,
      result: task.finalResponse.slice(0, maxChars), error: task.errorMessage.slice(0, 1000),
      ...(task.finalResponse.length > maxChars ? { truncated: true, note: 'Read the child conversation for the full result.' } : {}) };
  }
  async poll() {
    const agent = this.target?.agent; if (this.closed || !agent || this.polling) return;
    this.polling = true;
    const notifications: Promise<void>[] = [];
    try {
      const tasks = await agent.list(); if (this.closed) return;
      // Reopening a call can observe independently running tasks from the same parent.
      for (const task of tasks) if (!this.preparing && task.status === 'running' && task.parentTurnId.startsWith('voice_turn_') && !this.watching.has(task.taskId)) {
        this.watching.add(task.taskId); this.announced.add(task.taskId);
      }
      this.activity(tasks.filter(task => this.watching.has(task.taskId) && task.status === 'running').length);
      for (const task of tasks) if (this.watching.has(task.taskId) && this.announced.has(task.taskId) && !this.delivered.has(task.taskId) && !this.delivering.has(task.taskId) && task.status !== 'running') {
        if (this.closed) return;
        const pending = this.notify(this.summary(task)).then(() => { this.delivered.add(task.taskId); })
          .catch(() => { /* Retry delivery later, never retry execution. */ })
          .finally(() => { this.delivering.delete(task.taskId); });
        this.delivering.set(task.taskId, pending); notifications.push(pending);
      }
      // Release observation while independent summaries run; audio and new task
      // states must not wait for a slow completion summary.
    } catch { /* A transient read/notification failure never ends audio or invents completion. */ }
    finally { this.polling = false; this.schedule(); }
    await Promise.allSettled(notifications);
  }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; this.submitting(false); }
}

export function realtimeConversationContext(target?: VoiceTarget) {
  const pairs: {role:'user'|'assistant';text:string}[][]=[];
  let question='';
  for (const message of target?.historyMessages ?? target?.messages ?? []) {
    if (message.metadata?.visibility==='internal' || message.metadata?.__bush_superseded) continue;
    if (message.role==='user') question=message.content.trim();
    if (question && message.role==='assistant' && message.content.trim() && message.metadata?.cardbush_terminal_snapshot && message.status==='completed') {
      pairs.push([{role:'user',text:question.slice(0,4000)},{role:'assistant',text:message.content.slice(0,4000)}]); question='';
    }
  }
  let chars=0; const selected: typeof pairs=[];
  for (const pair of pairs.reverse().slice(0,20)) { const size=JSON.stringify(pair).length; if (chars+size>22000) break; chars+=size; selected.unshift(pair); }
  return selected.flat();
}
