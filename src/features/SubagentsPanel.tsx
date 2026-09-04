import {
  CheckCircle2,
  Circle,
  Clock3,
  LoaderCircle,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import {
  fetchSubagentCapabilities,
  fetchSubagentRuntime,
} from '../backend/api';
import type {
  AppLanguage,
  BackendCapabilities,
  SubagentCapabilities,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
} from '../types';

export function SubagentsPanel({
  language,
  embedded = false,
  capabilities: backendCapabilities,
}: {
  language: AppLanguage;
  embedded?: boolean;
  capabilities?: BackendCapabilities;
}) {
  const [query, setQuery] = useState('');
  const [runtime, setRuntime] = useState<SubagentRuntimeResult | null>(null);
  const [runtimeCapabilities, setRuntimeCapabilities] =
    useState<SubagentCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextRuntime, nextCapabilities] = await Promise.all([
        fetchSubagentRuntime(),
        fetchSubagentCapabilities().catch(() => null),
      ]);
      setRuntime(nextRuntime);
      setRuntimeCapabilities(nextCapabilities);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return runtime?.activeTasks ?? [];
    }
    return (runtime?.activeTasks ?? []).filter((task) =>
      taskSearchText(task).includes(normalized),
    );
  }, [query, runtime]);

  const supervisor = runtime?.supervisor ?? null;
  const supervisorTotalActive = supervisor
    ? subagentSupervisorTotalActive(supervisor)
    : runtime?.activeTasks.length ?? 0;
  const frontendMutationsAllowed =
    backendCapabilities?.subagentFrontendConfiguration === true;
  const remoteAgentsViaMcp = backendCapabilities?.remoteAgentsViaMcp === true;

  return (
    <div
      className={
        embedded
          ? 'subagents-content subagents-settings-content'
          : 'feature-content subagents-content'
      }
    >
      <div className="feature-toolbar subagent-readonly-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={language === 'zh' ? '搜索活动任务' : 'Search active tasks'}
          />
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '刷新状态' : 'Refresh'}
        </button>
      </div>

      <p className="feature-hint">
        {language === 'zh'
          ? '子任务由 Runtime 按需创建和调度。此页面只展示任务、准入限制和能力，不维护固定 Agent。'
          : 'Subtasks are created and scheduled on demand by the Runtime. This read-only view shows tasks, admission limits, and capabilities without maintaining fixed agents.'}
      </p>
      {error && <p className="feature-error">{error}</p>}

      <section className={`subagent-supervisor-card ${supervisor?.enabled === false ? 'disabled' : ''}`}>
        <header>
          <span>
            <ShieldCheck size={17} />
            <strong>
              {language === 'zh' ? '子任务运行准入' : 'Task runtime admission'}
            </strong>
          </span>
          <em>
            {supervisor?.enabled === false
              ? language === 'zh'
                ? '已关闭'
                : 'Disabled'
              : language === 'zh'
                ? 'Runtime 托管'
                : 'Runtime managed'}
          </em>
        </header>
        <div className="subagent-supervisor-grid">
          <InfoRow
            label={language === 'zh' ? '调度方式' : 'Scheduling'}
            value={language === 'zh' ? '运行时按需创建' : 'Runtime on demand'}
          />
          <InfoRow
            label={language === 'zh' ? '前端配置' : 'Frontend config'}
            value={
              frontendMutationsAllowed
                ? language === 'zh'
                  ? 'Runtime 允许'
                  : 'Runtime enabled'
                : language === 'zh'
                  ? '只读'
                  : 'Read-only'
            }
          />
          <InfoRow
            label={language === 'zh' ? '活动任务' : 'Active tasks'}
            value={formatSubagentLimit(
              supervisorTotalActive,
              supervisor?.limits.maxActiveTotal,
            )}
          />
          <InfoRow
            label={language === 'zh' ? '外部能力' : 'External capabilities'}
            value={
              remoteAgentsViaMcp
                ? 'MCP'
                : language === 'zh'
                  ? '未声明'
                  : 'Unknown'
            }
          />
          <InfoRow
            label={language === 'zh' ? '最大深度' : 'Max depth'}
            value={limitValue(supervisor?.limits.maxDepth, language)}
          />
          <InfoRow
            label="TTL"
            value={formatSecondsLimit(supervisor?.limits.taskTtlSeconds, language)}
          />
        </div>
      </section>

      <div className="subagent-readonly-policy">
        <PolicyPill
          icon={<Network size={14} />}
          label={language === 'zh' ? '任务委派' : 'Delegation'}
          value={language === 'zh' ? '运行时决定' : 'Runtime decides'}
        />
        <PolicyPill
          icon={<Circle size={14} />}
          label={language === 'zh' ? '配置边界' : 'Configuration'}
          value={language === 'zh' ? '无固定 Agent' : 'No fixed agents'}
        />
        <PolicyPill
          icon={<CheckCircle2 size={14} />}
          label={language === 'zh' ? '外部扩展' : 'External extensions'}
          value={
            remoteAgentsViaMcp
              ? language === 'zh'
                ? '通过 MCP 接入'
                : 'Use MCP servers'
              : language === 'zh'
                ? '由 Runtime 声明'
                : 'Declared by Runtime'
          }
        />
      </div>

      <section className="subagent-runtime-overview">
        <header className="subagent-map-header">
          <div>
            <span>{language === 'zh' ? '当前运行' : 'Current runtime'}</span>
            <strong>{language === 'zh' ? '活动子任务' : 'Active tasks'}</strong>
          </div>
          <em>{runtime?.activeTasks.length ?? 0}</em>
        </header>

        <div className="subagent-runtime-task-list">
          {activeTasks.map((task, index) => (
            <RuntimeTaskRow
              key={runtimeTaskKey(task, index)}
              task={task}
              language={language}
            />
          ))}
          {activeTasks.length === 0 && (
            <div className="subagent-empty-state compact">
              <Network size={20} />
              <strong>
                {query.trim()
                  ? language === 'zh'
                    ? '没有匹配的活动任务'
                    : 'No matching active tasks'
                  : language === 'zh'
                    ? '当前没有活动子任务'
                    : 'No active subtasks'}
              </strong>
              <span>
                {language === 'zh'
                  ? '运行时创建任务后会在这里出现，不需要预先注册 Agent。'
                  : 'Tasks appear here when the runtime creates them; no agent registration is required.'}
              </span>
            </div>
          )}
        </div>

        <RuntimeCapabilitySummary
          capabilities={runtimeCapabilities}
          language={language}
        />
      </section>
    </div>
  );
}

function RuntimeTaskRow({
  task,
  language,
}: {
  task: Record<string, unknown>;
  language: AppLanguage;
}) {
  const title = recordText(task, ['title', 'display_name', 'displayName', 'name']) ||
    (language === 'zh' ? '运行中的子任务' : 'Running subtask');
  const id = recordText(task, ['task_id', 'taskId', 'id']);
  const profile = recordText(task, [
    'resolved_runtime_profile',
    'resolvedRuntimeProfile',
    'runtime_profile',
    'runtimeProfile',
    'profile',
  ]);
  const status = recordText(task, ['status', 'state']) || 'running';
  const prompt = recordText(task, ['summary', 'message', 'prompt', 'description']);

  return (
    <article className="subagent-runtime-task">
      <span className={`subagent-runtime-task-state ${status.toLowerCase()}`}>
        <Clock3 size={14} />
      </span>
      <div>
        <strong>{title}</strong>
        {prompt && <p>{prompt}</p>}
        <small>
          {[profile, id].filter(Boolean).join(' · ') ||
            (language === 'zh' ? 'Runtime 任务' : 'Runtime task')}
        </small>
      </div>
      <em>{runtimeStatusLabel(status, language)}</em>
    </article>
  );
}

function RuntimeCapabilitySummary({
  capabilities,
  language,
}: {
  capabilities: SubagentCapabilities | null;
  language: AppLanguage;
}) {
  const chips = [
    ...compactList(capabilities?.runModes ?? [], 4),
    ...compactList(capabilities?.toolProfiles ?? [], 4),
    ...compactList(capabilities?.toolPackages ?? [], 4),
  ];

  return (
    <div className="subagent-runtime-capabilities">
      <span>{language === 'zh' ? '运行能力' : 'Runtime capabilities'}</span>
      <div className="subagent-chip-row">
        {chips.map((item) => <b key={item}>{item}</b>)}
        {chips.length === 0 && (
          <em>
            {language === 'zh' ? '由 Runtime 在任务创建时解析' : 'Resolved by the Runtime when a task is created'}
          </em>
        )}
      </div>
    </div>
  );
}

function PolicyPill({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="subagent-policy-pill">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function subagentSupervisorTotalActive(supervisor: SubagentSupervisorSnapshot) {
  if (Number.isFinite(supervisor.counts.totalActive)) {
    return supervisor.counts.totalActive ?? 0;
  }
  return Object.values(supervisor.counts.agentActive).reduce(
    (sum, value) => sum + value,
    0,
  );
}

function formatSubagentLimit(current: number, limit?: number) {
  return limit == null ? String(current) : `${current} / ${limit}`;
}

function limitValue(value: number | undefined, language: AppLanguage) {
  return value == null ? (language === 'zh' ? '无限制' : 'Unlimited') : String(value);
}

function formatSecondsLimit(value: number | undefined, language: AppLanguage) {
  if (value == null) {
    return language === 'zh' ? '无限制' : 'Unlimited';
  }
  if (value >= 3600 && value % 3600 === 0) {
    return `${value / 3600}h`;
  }
  if (value >= 60 && value % 60 === 0) {
    return `${value / 60}m`;
  }
  return `${value}s`;
}

function compactList(items: string[], limit: number) {
  return items.length <= limit
    ? items
    : [...items.slice(0, limit), `+${items.length - limit}`];
}

function recordText(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const text = String(value[key] ?? '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function taskSearchText(task: Record<string, unknown>) {
  return [
    recordText(task, ['title', 'display_name', 'displayName', 'name']),
    recordText(task, ['task_id', 'taskId', 'id']),
    recordText(task, ['summary', 'message', 'prompt', 'description']),
    recordText(task, ['runtime_profile', 'runtimeProfile', 'profile']),
    recordText(task, ['status', 'state']),
  ].join(' ').toLowerCase();
}

function runtimeTaskKey(task: Record<string, unknown>, index: number) {
  return recordText(task, ['task_id', 'taskId', 'id']) || `runtime-task-${index}`;
}

function runtimeStatusLabel(status: string, language: AppLanguage) {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'queued' || normalized === 'pending') {
    return language === 'zh' ? '等待中' : 'Queued';
  }
  if (normalized === 'blocked') {
    return language === 'zh' ? '已阻塞' : 'Blocked';
  }
  return language === 'zh' ? '运行中' : 'Running';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
