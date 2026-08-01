import {
  AlertCircle,
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
  fetchSubagentDetail,
  fetchSubagents,
  fetchSubagentRuntime,
  fetchSubagentTemplates,
  fetchSubagentUsage,
} from '../backend/api';
import type {
  AppLanguage,
  BackendCapabilities,
  SubagentCapabilities,
  SubagentDetail,
  SubagentListItem,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
  SubagentTemplate,
  SubagentUsageResult,
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
  const [agents, setAgents] = useState<SubagentListItem[]>([]);
  const [runtime, setRuntime] = useState<SubagentRuntimeResult | null>(null);
  const [subagentCapabilities, setSubagentCapabilities] =
    useState<SubagentCapabilities | null>(null);
  const [templates, setTemplates] = useState<SubagentTemplate[]>([]);
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [usage, setUsage] = useState<SubagentUsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const runtimeByAgent = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const item of runtime?.items ?? []) {
      map.set(item.id, item.runtime);
      map.set(item.name, item.runtime);
    }
    return map;
  }, [runtime]);

  const supervisor = runtime?.supervisor ?? null;
  const supervisorTotalActive = supervisor
    ? subagentSupervisorTotalActive(supervisor)
    : 0;
  const frontendMutationsAllowed =
    backendCapabilities?.subagentFrontendConfiguration === true;
  const remoteAgentsViaMcp = backendCapabilities?.remoteAgentsViaMcp === true;

  const filteredAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return agents
      .filter((agent) => {
        if (!normalized) {
          return true;
        }
        return `${agent.name} ${agent.displayName} ${agent.description} ${agent.tags.join(' ')} ${agent.source}`
          .toLowerCase()
          .includes(normalized);
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [agents, query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextAgents, nextRuntime, nextCapabilities, nextTemplates] =
        await Promise.all([
          fetchSubagents(),
          fetchSubagentRuntime().catch(() => null),
          fetchSubagentCapabilities().catch(() => null),
          fetchSubagentTemplates().catch(() => []),
        ]);
      setAgents(nextAgents);
      setRuntime(nextRuntime);
      setSubagentCapabilities(nextCapabilities);
      setTemplates(nextTemplates);
      setDetail((current) =>
        current &&
        nextAgents.some((agent) => agent.id === current.id || agent.name === current.name)
          ? current
          : null,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (agent: SubagentListItem) => {
    const id = agent.id || agent.name;
    setDetailLoading(true);
    setError('');
    try {
      const [nextDetail, nextUsage] = await Promise.all([
        fetchSubagentDetail(id),
        fetchSubagentUsage(id).catch(() => null),
      ]);
      setDetail(nextDetail);
      setUsage(nextUsage);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (detail || detailLoading || filteredAgents.length === 0) {
      return;
    }
    void openDetail(filteredAgents[0]);
  }, [detail, detailLoading, filteredAgents, openDetail]);

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
            placeholder={language === 'zh' ? '搜索本地子任务' : 'Search local subagents'}
          />
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '刷新状态' : 'Refresh'}
        </button>
      </div>

      <p className="feature-hint">
        {language === 'zh'
          ? '本地子任务由主 Agent 自动调度，前端只读观察；远程 Agent 请通过 MCP 服务器接入。'
          : 'Local subagents are scheduled by the parent agent. This view is read-only; remote agents are configured through MCP servers.'}
      </p>
      {error && <p className="feature-error">{error}</p>}

      <section className={`subagent-supervisor-card ${supervisor?.enabled === false ? 'disabled' : ''}`}>
        <header>
          <span>
            <ShieldCheck size={17} />
            <strong>
              {language === 'zh' ? 'Supervisor 运行准入' : 'Supervisor admission'}
            </strong>
          </span>
          <em>
            {supervisor?.enabled === false
              ? language === 'zh'
                ? '已关闭'
                : 'Disabled'
              : language === 'zh'
                ? '后端托管'
                : 'Backend managed'}
          </em>
        </header>
        <div className="subagent-supervisor-grid">
          <InfoRow
            label={language === 'zh' ? '本地默认' : 'Local default'}
            value={
              backendCapabilities?.subagentLocalDefault
                ? language === 'zh'
                  ? '开启'
                  : 'On'
                : language === 'zh'
                  ? '未声明'
                  : 'Unknown'
            }
          />
          <InfoRow
            label={language === 'zh' ? '前端配置' : 'Frontend config'}
            value={
              frontendMutationsAllowed
                ? language === 'zh'
                  ? '可配置'
                  : 'Configurable'
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
            label={language === 'zh' ? '远程 Agent' : 'Remote agents'}
            value={
              remoteAgentsViaMcp
                ? 'MCP'
                : language === 'zh'
                  ? '等待能力'
                  : 'Unavailable'
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
          label={language === 'zh' ? '本地子任务' : 'Local subagent'}
          value={language === 'zh' ? '由主 Agent 自动调度' : 'Parent agent decides'}
        />
        <PolicyPill
          icon={<Circle size={14} />}
          label={language === 'zh' ? '配置状态' : 'Configuration'}
          value={
            frontendMutationsAllowed
              ? language === 'zh'
                ? '后端允许前端配置'
                : 'Frontend mutations enabled'
              : language === 'zh'
                ? '前端不可配置'
                : 'Frontend mutations disabled'
          }
        />
        <PolicyPill
          icon={<CheckCircle2 size={14} />}
          label={language === 'zh' ? '远程协作' : 'Remote collaboration'}
          value={
            language === 'zh'
              ? remoteAgentsViaMcp
                ? '通过 MCP 接入'
                : '等待 MCP 能力'
              : remoteAgentsViaMcp
                ? 'Use MCP servers'
                : 'Waiting for MCP support'
          }
        />
      </div>

      <div className="subagent-workbench subagent-readonly-workbench">
        <section className="subagent-map-pane">
          <div className="subagent-map-header">
            <div>
              <span>{language === 'zh' ? '子任务状态' : 'Subagent status'}</span>
              <strong>{language === 'zh' ? '只读运行视图' : 'Read-only runtime'}</strong>
            </div>
            <em>{agents.length}</em>
          </div>
          <div className="subagent-map-grid">
            {filteredAgents.map((agent) => {
              const activeCount = subagentAgentActiveCount(
                supervisor,
                agent,
                runtimeNumber(runtimeByAgent.get(agent.id) ?? runtimeByAgent.get(agent.name), [
                  'active',
                  'active_tasks',
                  'activeTasks',
                ]),
              );
              const selected = detail?.id === agent.id || detail?.name === agent.name;
              return (
                <button
                  key={agent.id || agent.name}
                  className={`result-card subagent subagent-agent-node ${selected ? 'selected' : ''} ${activeCount > 0 ? 'running' : ''}`}
                  type="button"
                  onClick={() => void openDetail(agent)}
                >
                  <span className="subagent-avatar-frame">
                    <Network size={21} />
                  </span>
                  <span className="subagent-card-main">
                    <h3>{agent.displayName || agent.name}</h3>
                    <p>{agent.description || agent.source || 'local-subagent'}</p>
                    <small>{agent.name}</small>
                  </span>
                  <span className={`subagent-status ${agent.validationStatus}`}>
                    <b>{subagentStatusLabel(agent, language)}</b>
                  </span>
                  <span className="subagent-readonly-meta">
                    {activeCount > 0 ? (
                      <>
                        <Clock3 size={12} />
                        {activeCount}
                      </>
                    ) : (
                      language === 'zh' ? '空闲' : 'Idle'
                    )}
                  </span>
                </button>
              );
            })}
            {filteredAgents.length === 0 && (
              <div className="subagent-empty-state">
                <Network size={22} />
                <strong>
                  {language === 'zh' ? '没有可展示的本地子任务' : 'No local subagents'}
                </strong>
                <span>
                  {language === 'zh'
                    ? '后端通常会提供 local-subagent；远程能力请在 MCP 页面配置。'
                    : 'The backend normally exposes local-subagent. Configure remote capabilities under MCP.'}
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="subagent-detail-pane">
          {detailLoading && (
            <div className="feature-loading inline">
              <LoaderCircle size={18} />
              <span>{language === 'zh' ? '正在读取详情...' : 'Loading detail...'}</span>
            </div>
          )}
          {!detailLoading && detail ? (
            <SubagentReadonlyDetail
              detail={detail}
              usage={usage}
              capabilities={subagentCapabilities}
              templates={templates}
              runtime={runtimeByAgent.get(detail.id) ?? runtimeByAgent.get(detail.name)}
              language={language}
            />
          ) : !detailLoading ? (
            <div className="subagent-empty-state detail">
              <Network size={24} />
              <strong>
                {language === 'zh' ? '选择一个子任务' : 'Select a subagent'}
              </strong>
              <span>
                {language === 'zh'
                  ? '这里只展示运行信息、基础配置和后端准入状态。'
                  : 'This pane only shows runtime information, base config, and backend admission state.'}
              </span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function SubagentReadonlyDetail({
  detail,
  usage,
  capabilities,
  templates,
  runtime,
  language,
}: {
  detail: SubagentDetail;
  usage: SubagentUsageResult | null;
  capabilities: SubagentCapabilities | null;
  templates: SubagentTemplate[];
  runtime?: Record<string, unknown>;
  language: AppLanguage;
}) {
  const runtimeProfile =
    detail.toolProfile ||
    runtimeText(runtime, ['runtime_profile', 'runtimeProfile', 'profile']) ||
    '';
  const recentCount = usage?.recent.length ?? 0;
  const toolCount = detail.tools.length || capabilities?.tools.length || 0;
  const skillCount = detail.skills.length || capabilities?.skills.length || 0;

  return (
    <div className="subagent-readonly-detail">
      <header>
        <span className="subagent-avatar-frame large">
          <Network size={24} />
        </span>
        <div>
          <strong>{detail.displayName || detail.name}</strong>
          <small>{detail.name} · {detail.source || 'managed-local'}</small>
        </div>
        <span className={`subagent-status ${detail.validationStatus}`}>
          <b>{subagentStatusLabel(detail, language)}</b>
        </span>
      </header>

      {detail.error && (
        <p className="feature-error subagent-inline-error">
          <AlertCircle size={14} />
          {detail.error}
        </p>
      )}

      <p className="subagent-readonly-description">
        {detail.description ||
          (language === 'zh'
            ? '后端托管的本地子任务能力。'
            : 'Backend-managed local subtask capability.')}
      </p>

      <div className="subagent-detail-grid compact">
        <InfoRow
          label={language === 'zh' ? '控制面' : 'Control plane'}
          value="managed-local"
        />
        <InfoRow
          label={language === 'zh' ? '前端可配置' : 'Frontend configurable'}
          value={language === 'zh' ? '否' : 'No'}
        />
        <InfoRow
          label={language === 'zh' ? '工具' : 'Tools'}
          value={String(toolCount)}
        />
        <InfoRow
          label="Skills"
          value={String(skillCount)}
        />
        <InfoRow
          label={language === 'zh' ? '运行策略' : 'Runtime policy'}
          value={runtimeProfile || (language === 'zh' ? '后端决定' : 'Backend decides')}
        />
        <InfoRow
          label={language === 'zh' ? '最近任务' : 'Recent tasks'}
          value={String(recentCount)}
        />
      </div>

      <section className="subagent-readonly-section">
        <span>{language === 'zh' ? '能力摘要' : 'Capability summary'}</span>
        <div className="subagent-chip-row">
          {compactList(detail.tools, 8).map((item) => (
            <b key={`tool-${item}`}>{item}</b>
          ))}
          {compactList(detail.skills, 6).map((item) => (
            <b key={`skill-${item}`}>skill:{item}</b>
          ))}
          {detail.tools.length === 0 && detail.skills.length === 0 && (
            <em>{language === 'zh' ? '由后端运行时决定' : 'Resolved by backend runtime'}</em>
          )}
        </div>
      </section>

      <section className="subagent-readonly-section">
        <span>{language === 'zh' ? '后端边界' : 'Backend boundary'}</span>
        <p>
          {language === 'zh'
            ? '这里不再支持注册、编辑、启用、禁用或删除本地子 Agent。主 Agent 会根据任务上下文自行决定是否调用本地子任务；远程 Agent 统一走 MCP。'
            : 'Register, edit, enable, disable, and delete operations are no longer exposed here. The parent agent decides when to use local subagents; remote agents go through MCP.'}
        </p>
      </section>

      {templates.length > 0 && (
        <section className="subagent-readonly-section">
          <span>{language === 'zh' ? '模板' : 'Templates'}</span>
          <p>
            {language === 'zh'
              ? `后端返回 ${templates.length} 个模板，但前端不再提供创建入口。`
              : `${templates.length} templates are available from the backend, but creation is not exposed in the frontend.`}
          </p>
        </section>
      )}
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

function subagentStatusLabel(agent: Pick<SubagentListItem, 'enabled' | 'validationStatus'>, language: AppLanguage) {
  if (agent.validationStatus === 'invalid') {
    return language === 'zh' ? '异常' : 'Invalid';
  }
  if (!agent.enabled || agent.validationStatus === 'disabled') {
    return language === 'zh' ? '关闭' : 'Disabled';
  }
  return language === 'zh' ? '可用' : 'Available';
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

function subagentAgentActiveCount(
  supervisor: SubagentSupervisorSnapshot | null | undefined,
  agent: Pick<SubagentListItem, 'id' | 'name'>,
  fallback: number,
) {
  if (!supervisor) {
    return Number.isFinite(fallback) ? fallback : 0;
  }
  const fromName = supervisor.counts.agentActive[agent.name];
  const fromId = supervisor.counts.agentActive[agent.id];
  const value = fromName ?? fromId ?? fallback;
  return Number.isFinite(value) ? value : 0;
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
  if (items.length <= limit) {
    return items;
  }
  return [...items.slice(0, limit), `+${items.length - limit}`];
}

function runtimeNumber(
  value: Record<string, unknown> | undefined,
  keys: string[],
) {
  if (!value) {
    return 0;
  }
  for (const key of keys) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return 0;
}

function runtimeText(
  value: Record<string, unknown> | undefined,
  keys: string[],
) {
  if (!value) {
    return '';
  }
  for (const key of keys) {
    const text = String(value[key] ?? '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
