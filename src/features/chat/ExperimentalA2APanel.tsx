import {
  Ban,
  CircleDotDashed,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Send,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  dispatchExperimentalA2ATask,
  fetchExperimentalGoalA2AStatus,
  inspectExperimentalA2AAgent,
  type A2AAgentCard,
  type A2ATask,
} from '../../backend/api';
import type { AppLanguage } from '../../types';

const lastAgentUrlKey = 'cardbush.experimental_a2a.agent_url';

export function ExperimentalA2APanel({
  language,
}: {
  language: AppLanguage;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agentUrl, setAgentUrl] = useState(() => {
    try { return window.localStorage.getItem(lastAgentUrlKey) ?? ''; } catch { return ''; }
  });
  const [agent, setAgent] = useState<A2AAgentCard | null>(null);
  const [taskText, setTaskText] = useState('');
  const [tasks, setTasks] = useState<A2ATask[]>([]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const status = await fetchExperimentalGoalA2AStatus();
      setAvailable(status.enabled);
    } catch (caught) {
      setAvailable(false);
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await action(); } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  }

  const inspectAgent = () => run(async () => {
    const normalized = agentUrl.trim();
    if (!normalized) return;
    const inspected = await inspectExperimentalA2AAgent(normalized);
    setAgent(inspected);
    try { window.localStorage.setItem(lastAgentUrlKey, normalized); } catch { /* noop */ }
  });

  const dispatchTask = () => run(async () => {
    const text = taskText.trim();
    const normalizedUrl = agentUrl.trim();
    if (!text || !normalizedUrl) return;
    const task = await dispatchExperimentalA2ATask({
      agentUrl: normalizedUrl,
      text,
    });
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
    setTaskText('');
    await refresh();
  });

  if (available == null) {
    return <div className="experimental-a2a-loading"><LoaderCircle className="spin" size={15} />{language === 'zh' ? '正在探测实验服务' : 'Detecting experiment'}</div>;
  }
  if (!available) {
    return (
      <div className="experimental-a2a-disabled">
        <Ban size={18} />
        <strong>{language === 'zh' ? 'A2A 未启用' : 'A2A is disabled'}</strong>
        <p>{language === 'zh' ? 'A2A 出站客户端仅在 CardBush 桌面版中提供。' : 'The outbound A2A client is available in CardBush Desktop.'}</p>
        {error && <small>{error}</small>}
        <button type="button" onClick={() => void refresh()}><RefreshCw size={13} />{language === 'zh' ? '重新探测' : 'Retry'}</button>
      </div>
    );
  }

  return (
    <section className="experimental-a2a-panel">
      <header>
        <div><span className="work-summary-kicker">A2A</span><h2>{language === 'zh' ? '协作任务' : 'Collaborative task'}</h2></div>
        <button type="button" disabled={busy} onClick={() => void refresh()} title={language === 'zh' ? '刷新' : 'Refresh'}><RefreshCw size={13} /></button>
      </header>

      <div className="experimental-a2a-agent">
        <div className="experimental-section-title"><img className="a2a-official-icon" src="./a2a-icon.svg" alt="" /><strong>A2A Agent</strong></div>
        <div className="experimental-agent-url"><input value={agentUrl} onChange={(event) => { setAgentUrl(event.currentTarget.value); setAgent(null); }} placeholder="http://127.0.0.1:51718" /><button type="button" disabled={busy || !agentUrl.trim()} onClick={() => void inspectAgent()}><ExternalLink size={12} />{language === 'zh' ? '探测' : 'Inspect'}</button></div>
        {agent && <div className="experimental-agent-card"><strong>{agent.name}</strong><small>{agent.description}</small><span>{agent.protocolVersions.join(', ')} · {agent.skills.length} skills{agent.streaming ? ' · stream' : ''}</span></div>}
        <textarea rows={3} value={taskText} onChange={(event) => setTaskText(event.currentTarget.value)} placeholder={language === 'zh' ? '发送给远端 Agent 的任务' : 'Task for the remote agent'} />
        <button className="experimental-a2a-send" type="button" disabled={busy || !agentUrl.trim() || !taskText.trim()} onClick={() => void dispatchTask()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}{language === 'zh' ? '派发任务' : 'Dispatch task'}</button>
      </div>

      {error && <p className="experimental-a2a-error">{error}</p>}
      {tasks.length > 0 && <div className="experimental-a2a-tasks">{tasks.map((task) => <article key={task.id}><CircleDotDashed size={12} /><div><strong>{task.state.replace('TASK_STATE_', '')}</strong><small>{task.artifactText || task.statusMessage || task.id}</small></div></article>)}</div>}
    </section>
  );
}
