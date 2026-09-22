import { useEffect, useMemo, useState } from 'react';
import type { RuntimePermissionRequest, RuntimeSolutionSelection, SubagentTask } from '@cardbush/bush-protocol';
import type { AgentOperation } from '../../../electron/agentTypes';
import type { AppLanguage, PendingInteraction } from '../../types';
import { ProtocolRuntimeClient } from '../../runtime-client/ProtocolRuntimeClient';
import { InteractionCard } from '../interactions/InteractionCard';

export type AgentCall = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
export function agentRuntimeClient(call: AgentCall) {
  return new ProtocolRuntimeClient({ sendCommand: (command) => call('runtime.command', { ...command }), async *openEventStream() {} });
}

export function AgentInteractions({ call, scope, language, sessionId, permissions, selection }: { call: AgentCall; scope: string; sessionId: string; language: AppLanguage;
  permissions: Array<RuntimePermissionRequest & { permissionId: string }>; selection?: RuntimeSolutionSelection }) {
  return <>{permissions.map(permission => {
    const interaction: PendingInteraction = { id: `${scope}:${permission.permissionId}`, sessionId: `${scope}:${sessionId}`, type: 'path_permission_request',
      raw: {}, title: 'Permission', reason: permission.reason, runtimePermission: permission,
      questions: [{ id: 'permission', label: 'Permission', question: permission.reason, options: [
        { id: 'allow_once', label: 'Allow once' }, { id: 'allow_session', label: 'Allow for this session' }, { id: 'deny', label: 'Deny' } ] }] };
    const answer = (decision: string) => call('runtime.command', { kind: 'runtime.answer_permission', payload: { protocol: 'bush.runtime_permission_answer.v1', permissionId: permission.permissionId,
      answerId: crypto.randomUUID(), decision, grantedCapabilityIds: ['allow_once', 'allow_session'].includes(decision) ? permission.requestedCapabilityIds : [] } }).then(() => undefined);
    return <InteractionCard key={interaction.id} language={language} interaction={interaction} onReply={answers => answer(answers[0]?.selectedOptionId || 'deny')} onCancel={() => answer('cancel')}/>;
  })}{selection && <InteractionCard key={`${scope}:${selection.selectionId}`} language={language} interaction={{ id: `${scope}:${selection.selectionId}`, sessionId: `${scope}:${sessionId}`, type: 'solution_selection',
    raw: {}, questions: [{ id: 'solution', label: 'Solution', question: selection.prompt, options: selection.options.map((label, index) => ({ id: String(index), label })) }] }}
    onReply={answers => call('runtime.command', { kind: 'runtime.answer_solution_selection', payload: { sessionId, turnId: selection.turnId, selectionId: selection.selectionId,
      ...(answers[0]?.text ? { kind: 'text', text: answers[0].text } : { kind: 'option', optionIndex: Number(answers[0]?.selectedOptionId) }) } }).then(() => undefined)}
    onCancel={() => call('runtime.command', { kind: 'runtime.answer_solution_selection', payload: { sessionId, turnId: selection.turnId, selectionId: selection.selectionId, kind: 'cancel' } }).then(() => undefined)}/>}</>;
}

export function AgentSubagents({ call, sessionId, language, active, onOpen }: { call: AgentCall; sessionId: string; language: AppLanguage; active: boolean; onOpen: (sessionId: string) => void }) {
  const [tasks, setTasks] = useState<SubagentTask[]>([]);
  const client = useMemo(() => agentRuntimeClient(call), [call]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try { const next = await client.listSubagentTasks({ parentSessionId: sessionId }); if (alive) setTasks(next); }
      finally { if (alive && active) timer = setTimeout(() => { void read().catch(() => {}); }, 2500); }
    };
    void read().catch(() => {}); return () => { alive = false; clearTimeout(timer); };
  }, [client, sessionId, active]);
  if (!tasks.length) return null;
  return <details className="agent-subagents"><summary>{language === 'zh' ? '子代理任务' : 'Subagent tasks'} · {tasks.length}</summary>{tasks.map(task => <div className="agent-settings-row" key={task.taskId}>
    <div><strong>{task.prompt.slice(0, 90)}</strong><small>{language === 'zh' ? ({ running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止' })[task.status] : task.status}</small>
      {task.errorMessage && <p>{task.errorMessage}</p>}</div><button onClick={() => onOpen(task.childSessionId)}>{language === 'zh' ? '查看对话' : 'Open conversation'}</button>
  </div>)}</details>;
}
