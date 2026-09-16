import { memo, Profiler, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { ChatPanel } from '../../chat/ChatPanel';
import { createStreamingReplay, replaySemanticSnapshot, replayDifferencePaths, replaySession, replayTurn, type ReplayFixture } from './streamingReplay';
import { scenarios, streamingFixture, type Scenario } from './fixtures';
import type { HistoryReplay, HistoryReplayCollection } from './historyReplay';
import './streaming-lab.css';

const noop = () => {};
const asyncNoop = async () => {};
const panelDefaults: Omit<ComponentProps<typeof ChatPanel>, 'messages' | 'sending' | 'theme'> = {
  language: 'zh', title: '本地事件回放', sidebarCollapsed: true, windowMaximized: false,
  inspectorOpen: false, onToggleInspector: noop, activeConversationId: replaySession,
  activeProjectDir: '', projectPathAliases: [], selectedProjectDir: '', availableProjects: [],
  onWelcomeProjectChange: asyncNoop, activeGoal: null, goalAvailable: false,
  goalCancelling: false, goalWaiting: false, changeReports: [], skills: [], disabledSkillNames: new Set(),
  contextSearchAvailable: false, subagentObservabilityAvailable: false, shadowAvailable: false,
  shadowAccentColor: '#999999', shadowThemeVariables: {}, thinkingVisible: false, guidanceDeliveryMode: 'queue',
  loading: false, historyLoading: false, stopping: false, activeTurnId: replayTurn,
  queuedMessageCount: 0, queuedMessagePreview: '', queuedMessages: [], pendingInteraction: null,
  error: null, notice: null, selectedModel: '本地回放', availableModels: [], referencePlanAvailable: false,
  referencePlanMode: 'off', permissionMode: 'task_free', subagentPermissionRouting: 'user',
  reasoningLevelAvailable: false, reasoningLevel: 'high', reasoningLevels: [],
  onModelChange: noop, onReferencePlanModeChange: noop, onPermissionModeChange: noop,
  onSubagentPermissionRoutingChange: noop, onReasoningLevelChange: noop, onConfigureModels: noop,
  onCreateConversation: noop, onToggleSkill: noop, onRefreshActiveSession: asyncNoop, onSend: asyncNoop,
  onRetryMessage: asyncNoop, onRegenerate: asyncNoop, onEditUserMessage: asyncNoop,
  onGuideMessage: asyncNoop, onRetryGuidance: asyncNoop, onGuideQueuedMessage: asyncNoop,
  onRemoveQueuedMessage: noop, onReorderQueuedMessage: noop, onRevertChangeReport: asyncNoop,
  onOpenChangeReview: noop, onReplyInteraction: asyncNoop, onCancelInteraction: asyncNoop,
  onCancelGoal: asyncNoop, onCancel: asyncNoop, onClearError: noop, onClearNotice: noop,
  draft: '', onDraftChange: noop,
};
const createRun = (scenario: string, histories: HistoryReplay[] = []) => {
  const history = histories.find(item => item.id === scenario);
  if (!history && !Object.hasOwn(scenarios, scenario)) throw new Error(`Unknown replay: ${scenario}`);
  const fixture: ReplayFixture = history ?? streamingFixture(scenario as Scenario);
  return { scenario, fixture, history, baseline: createStreamingReplay('baseline', fixture.initial, { identity: fixture.identity }),
    frame: createStreamingReplay('frame', fixture.initial, { identity: fixture.identity }), index: 0, disposed: false, seeking: false,
    renders: { baseline: { count: 0, maxMs: 0 }, frame: { count: 0, maxMs: 0 } } };
};
type Run = ReturnType<typeof createRun>;
export interface StreamingLabApi {
  reset: (scenario: string) => void;
  loadHistory: (cases: HistoryReplay[]) => void;
  differences: () => string[];
  step: () => void;
  finish: (stopBeforeTerminal?: boolean) => Promise<void>;
  state: () => { index: number; total: number; baseline: ReturnType<Run['baseline']['getSnapshot']>;
    frame: ReturnType<Run['frame']['getSnapshot']>; equal: boolean; nextEvent?: string; renders: Run['renders']; scenario: string };
}
declare global { interface Window { streamingLab?: StreamingLabApi } }

const Lane = memo(function Lane({ run, mode, theme }: { run: Run; mode: 'baseline' | 'frame'; theme: 'dark' | 'bright' }) {
  const replay = run[mode];
  const snapshot = useSyncExternalStore(replay.subscribe, replay.getSnapshot);
  return <section className="streaming-lab-lane" data-lane={mode}>
    <header><strong>{mode === 'baseline' ? '原有方案（对照）' : '逐帧输出（正式路径）'}</strong>
      <span>{mode === 'baseline' ? '段完成后播放 · 列表 500ms 合批' : '文字逐帧显示 · 纯工具状态保留合批'}</span>
      <small>首字释放 {snapshot.firstReleaseMs == null ? '—' : `${Math.round(snapshot.firstReleaseMs)}ms`}
        {' · '}文字提交 {snapshot.commits} 次</small></header>
    <div className="streaming-lab-chat">
      <Profiler id={mode} onRender={(_id, _phase, duration) => {
        run.renders[mode].count++;
        run.renders[mode].maxMs = Math.max(run.renders[mode].maxMs, duration);
      }}>
      <ChatPanel {...panelDefaults} messages={snapshot.messages} sending={snapshot.active} theme={theme}
        activeConversationId={run.fixture.identity?.sessionId ?? replaySession}
        activeTurnId={run.fixture.identity?.turnId ?? replayTurn}
        transcriptDelivery={mode === 'baseline' ? 'batched' : undefined} />
      </Profiler>
    </div>
  </section>;
});

export function StreamingLab() {
  const [run, setRun] = useState(() => createRun('guidance'));
  const [histories, setHistories] = useState<HistoryReplay[]>([]);
  const [historyNotice, setHistoryNotice] = useState('');
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [theme, setTheme] = useState<'dark' | 'bright'>('dark');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const baseline = useSyncExternalStore(run.baseline.subscribe, run.baseline.getSnapshot);
  const frame = useSyncExternalStore(run.frame.subscribe, run.frame.getSnapshot);
  const equal = JSON.stringify(replaySemanticSnapshot(baseline.messages)) === JSON.stringify(replaySemanticSnapshot(frame.messages));
  const pause = () => { clearTimeout(timer.current); timer.current = undefined; setPlaying(false); };
  const step = () => {
    if (run.disposed) return;
    const item = run.fixture.events[run.index++];
    if (!item) { run.index--; return; }
    run.baseline.accept(item.event);
    run.frame.accept(item.event);
    setIndex(run.index);
  };
  const reset = (scenario: string) => { pause(); run.disposed = true; setSeeking(false); setRun(createRun(scenario, histories)); setIndex(0); };
  const finish = async (stopBeforeTerminal = false) => {
    if (run.seeking || run.disposed) return;
    run.seeking = true; setSeeking(true);
    pause();
    try { while (!run.disposed && run.index < run.fixture.events.length) {
      const kind = run.fixture.events[run.index].event.kind;
      if (stopBeforeTerminal && kind === 'terminal') break;
      step();
      // Seeking is not a zero-interval network burst. Let each lifecycle
      // boundary settle, otherwise baseline animation can apply a tool after
      // later guidance and leave stale archived message status behind.
      if (kind !== 'delta') await Promise.all([run.baseline.idle(), run.frame.idle()]);
      else await Promise.resolve();
    }
    await Promise.all([run.baseline.idle(), run.frame.idle()]);
    } finally { run.seeking = false; if (!run.disposed) setSeeking(false); }
  };
  useEffect(() => () => { run.disposed = true; run.baseline.dispose(); run.frame.dispose(); }, [run]);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('synthetic')) return;
    let cancelled = false;
    void fetch('./history.json', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('no history');
      const data: HistoryReplayCollection = await response.json();
      if (data.version !== 1 || !Array.isArray(data.cases) || !data.cases.length) throw new Error('empty history');
      if (cancelled) return;
      setHistories(data.cases);
      setRun(createRun(data.cases[0].id, data.cases));
      setIndex(0); setPlaying(false); setSpeed(16);
      setHistoryNotice('');
    }).catch(() => { if (!cancelled) setHistoryNotice('尚未加载本地历史。使用 --history 导出后刷新；当前可回放模拟场景。'); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!playing) return;
    if (index >= run.fixture.events.length) { setPlaying(false); return; }
    const previousAt = run.fixture.events[index - 1]?.at ?? 0;
    timer.current = setTimeout(step, (run.fixture.events[index].at - previousAt) / speed);
    return () => clearTimeout(timer.current);
  }, [run, index, playing, speed]);
  useEffect(() => {
    window.streamingLab = { reset, step, finish, loadHistory: setHistories,
      differences: () => replayDifferencePaths(replaySemanticSnapshot(run.baseline.getSnapshot().messages),
        replaySemanticSnapshot(run.frame.getSnapshot().messages)),
      state: () => ({ index: run.index, scenario: run.scenario,
      nextEvent: run.fixture.events[run.index]?.event.kind,
      total: run.fixture.events.length, baseline: run.baseline.getSnapshot(), frame: run.frame.getSnapshot(),
      renders: run.renders,
      equal: JSON.stringify(replaySemanticSnapshot(run.baseline.getSnapshot().messages)) ===
        JSON.stringify(replaySemanticSnapshot(run.frame.getSnapshot().messages)),
    }) };
    return () => { delete window.streamingLab; };
  });

  return <div className={`app theme-${theme} streaming-lab`}>
    <header className="streaming-lab-controls">
      <div><h1>流式显示对照实验</h1><p>同一组本地事件，两条显示路径。复用正式聊天组件；不连接模型、不修改会话。</p></div>
      <div className="streaming-lab-actions">
        <select aria-label="测试场景" value={run.scenario} onChange={event => reset(event.target.value as Scenario)}>
          {histories.length > 0 && <optgroup label="本机真实历史">
            {histories.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </optgroup>}
          <optgroup label="模拟边界场景">{Object.entries(scenarios).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</optgroup>
        </select>
        <button disabled={seeking} onClick={() => playing ? pause() : setPlaying(true)}>{playing ? '暂停' : '开始回放'}</button>
        <button onClick={() => { pause(); step(); }} disabled={seeking || index >= run.fixture.events.length}>下一事件</button>
        <button disabled={seeking} onClick={() => void finish()}>{seeking ? '正在跳转…' : '直接完成'}</button>
        <button onClick={() => reset(run.scenario)}>重置</button>
        <select aria-label="回放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}>
          {[1, 4, 16, 64].map(value => <option key={value} value={value}>{value}×</option>)}
        </select>
        <button onClick={() => setTheme(theme === 'dark' ? 'bright' : 'dark')}>切换主题</button>
      </div>
      <output data-testid="streaming-lab-result">事件 {index}/{run.fixture.events.length} · {
        baseline.active || frame.active ? '回放中：中间文字长度允许不同' : equal ? '最终消息与工具状态一致' : '发现最终状态差异'}
      </output>
      {historyNotice && <p>{historyNotice}</p>}
      {run.history && <div className="streaming-lab-source">
        <p>真实历史 · {new Date(run.history.source.startedAt).toLocaleString('zh-CN')} · 原始时长 {formatTime(run.fixture.duration)}
          {' · '}已回放 {formatTime(run.fixture.events[index - 1]?.at ?? 0)} · {run.history.source.deltas} 次增量 / {run.history.source.tools} 次工具
          {run.history.source.subagents > 0 && ` / ${run.history.source.subagents} 次子任务`} · 原始状态 {run.history.source.status}</p>
        <p>{run.history.source.hasSnapshot ? '含完整消息快照' : '仅事件日志：原始提问和完整消息快照缺失'}
          {run.history.source.missingGuidanceText > 0 && ' · 引导原文缺失，显示明确占位'}
          {run.history.source.missingToolRecords > 0 && ` · ${run.history.source.missingToolRecords} 条工具结果缺失，仅显示状态`}
          {' · '}按日志顺序和原间隔回放（可倍速），思考/计划/审批不在本次显示对照范围。</p>
        <details><summary>来源与回放范围</summary><p>{run.history.source.sessionId}<br/>{run.history.source.turnId}<br/>
          {run.history.source.rawEvents} 条原始事件，过滤 {run.history.source.hiddenInputs} 条内部输入。回放不会重新执行工具。</p></details>
      </div>}
    </header>
    <main className="streaming-lab-columns">
      <Lane key={`baseline-${run.scenario}`} run={run} mode="baseline" theme={theme} />
      <Lane key={`frame-${run.scenario}`} run={run} mode="frame" theme={theme} />
    </main>
  </div>;
}

function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
