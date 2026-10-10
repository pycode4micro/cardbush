import { RefreshCw, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RuntimeTerminalStatus } from '@cardbush/bush-protocol';
import { controlTerminalTask } from '../../backend/terminalTasks';
import type { ConversationRuntime } from '../../backend/conversationRuntime';
import type { AppLanguage } from '../../types';

/** Only mounted in an expanded tool detail. Local clocks never update the transcript. */
export function TerminalTaskStatus({ sessionId, terminalSessionId, runtime, language }: {
  sessionId: string; terminalSessionId: string; runtime?: ConversationRuntime; language: AppLanguage;
}) {
  const container = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const stopRequested = useRef(false);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<RuntimeTerminalStatus>();
  const [observedAt, setObservedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [revision, setRevision] = useState(0);
  const finished = Boolean(status && status.state !== 'running');
  const hasStatus = Boolean(status);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let inView = false;
    const update = () => setVisible(inView && document.visibilityState !== 'hidden');
    const observer = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); update(); });
    if (container.current) observer.observe(container.current);
    document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    if (!visible || finished) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const current = await controlTerminalTask(sessionId, terminalSessionId, 'status', runtime, controller.signal);
        if (controller.signal.aborted || stopRequested.current) return;
        setStatus(current); setObservedAt(Date.now()); setNow(Date.now()); setError(false);
        if (current.state === 'running') timer = setTimeout(() => { void refresh(); }, 3000);
      } catch {
        if (!controller.signal.aborted && !stopRequested.current) setError(true);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, terminalSessionId, runtime, visible, finished, revision]);
  useEffect(() => {
    if (!visible || !status || finished || error) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, hasStatus, finished, error]);
  const stop = async () => {
    stopRequested.current = true;
    setStopping(true);
    try {
      const current = await controlTerminalTask(sessionId, terminalSessionId, 'stop', runtime);
      if (alive.current) { setStatus(current); setObservedAt(Date.now()); setError(false); }
    } catch { if (alive.current) { stopRequested.current = false; setError(true); } }
    finally { if (alive.current) setStopping(false); }
  };
  const zh = language === 'zh';
  const elapsed = Math.max(0, now - observedAt);
  const duration = Math.floor(((status?.durationMs ?? 0) + (finished ? 0 : elapsed)) / 1000);
  const idle = Math.floor(((status?.outputIdleMs ?? 0) + (finished ? 0 : elapsed)) / 1000);
  const label = status?.state === 'running' ? zh ? '后台运行' : 'Running in background'
    : status?.state === 'stopped' ? zh ? '已停止' : 'Stopped'
    : status?.state === 'failed' || status?.state === 'disconnected' || Boolean(status?.exitCode) ? zh ? '执行失败' : 'Failed'
    : zh ? '已结束' : 'Finished';
  return <div className="terminal-task-status" ref={container} aria-live="off">
    <span>{error ? zh ? '无法读取当前终端状态' : 'Terminal status unavailable'
      : !status ? zh ? '正在读取终端状态…' : 'Loading terminal status…'
      : `${label}${status.durationMs !== undefined ? ` · ${duration}s` : ''}${!finished && status.outputIdleMs !== undefined && idle >= 10 ? ` · ${zh ? `${idle} 秒无新输出` : `${idle}s without output`}` : ''}`}</span>
    {error && <button type="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={12} />{zh ? '刷新' : 'Refresh'}</button>}
    {status?.state === 'running' && <button type="button" disabled={stopping} onClick={() => { void stop(); }}><Square size={11} />{stopping ? zh ? '正在停止…' : 'Stopping…' : zh ? '停止进程' : 'Stop process'}</button>}
  </div>;
}
