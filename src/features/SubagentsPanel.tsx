import {
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

import {
  deleteSubagent,
  fetchSubagentCapabilities,
  fetchSubagentDetail,
  fetchSubagents,
  fetchSubagentRuntime,
  fetchSubagentTemplates,
  fetchSubagentUsage,
  patchSubagent,
  registerSubagent,
  reloadSubagents,
  setSubagentEnabled,
  validateSubagent,
} from '../backend/api';
import type {
  AppLanguage,
  SubagentCapabilities,
  SubagentDetail,
  SubagentListItem,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
  SubagentTemplate,
  SubagentUsageResult,
  SubagentValidationResult,
} from '../types';
import {
  characterPresetForAgent,
  GAME_CODING_SETTINGS_EVENT,
  gameCodingCharacterImageForAgent,
  gameCodingDisplayName,
  gameCodingMapImage,
  gameCodingRoleText,
  mapPresetForSettings,
  readGameCodingSettings,
  type GameCodingSettings,
} from './gameCodingPresets';
export function SubagentsPanel({ language }: { language: AppLanguage }) {
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<SubagentListItem[]>([]);
  const [runtime, setRuntime] = useState<SubagentRuntimeResult | null>(null);
  const [capabilities, setCapabilities] = useState<SubagentCapabilities | null>(null);
  const [templates, setTemplates] = useState<SubagentTemplate[]>([]);
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [usage, setUsage] = useState<SubagentUsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionId, setActionId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [gameCodingSettings, setGameCodingSettings] = useState<GameCodingSettings>(() =>
    readGameCodingSettings(),
  );

  const runtimeByAgent = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const item of runtime?.items ?? []) {
      map.set(item.name, item.runtime);
      map.set(item.id, item.runtime);
    }
    return map;
  }, [runtime]);
  const supervisor = runtime?.supervisor ?? null;
  const supervisorTotalActive = supervisor
    ? subagentSupervisorTotalActive(supervisor)
    : 0;
  const gameCodingMap = mapPresetForSettings(gameCodingSettings, agents);
  const subagentMapStyle = {
    '--subagent-map-image': `url("${gameCodingMapImage(gameCodingSettings, agents)}")`,
  } as CSSProperties;

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
      setCapabilities(nextCapabilities);
      setTemplates(nextTemplates);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const update = () => setGameCodingSettings(readGameCodingSettings());
    window.addEventListener(GAME_CODING_SETTINGS_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(GAME_CODING_SETTINGS_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  const updateAgent = useCallback((updated: SubagentDetail | SubagentListItem) => {
    setAgents((current) =>
      current.some((item) => item.id === updated.id || item.name === updated.name)
        ? current.map((item) =>
            item.id === updated.id || item.name === updated.name
              ? subagentSummaryFromDetail(updated)
              : item,
          )
        : [subagentSummaryFromDetail(updated), ...current],
    );
    setDetail((current) =>
      current && (current.id === updated.id || current.name === updated.name)
        ? { ...current, ...updated }
        : current,
    );
  }, []);

  const openDetail = useCallback(async (agent: SubagentListItem) => {
    setDetailLoading(true);
    setError('');
    setNotice('');
    try {
      const [nextDetail, nextUsage] = await Promise.all([
        fetchSubagentDetail(agent.id || agent.name),
        fetchSubagentUsage(agent.id || agent.name).catch(() => null),
      ]);
      setDetail(nextDetail);
      setUsage(nextUsage);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const toggleAgent = useCallback(
    async (agent: SubagentListItem) => {
      const id = agent.id || agent.name;
      setActionId(id);
      setError('');
      try {
        const updated = await setSubagentEnabled(id, !agent.enabled);
        updateAgent(updated);
        const nextRuntime = await fetchSubagentRuntime().catch(() => null);
        setRuntime(nextRuntime);
        setNotice(
          language === 'zh'
            ? `${updated.displayName} 已${updated.enabled ? '启用' : '关闭'}`
            : `${updated.displayName} ${updated.enabled ? 'enabled' : 'disabled'}`,
        );
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setActionId('');
      }
    },
    [language, updateAgent],
  );

  const rebuildRegistry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await reloadSubagents();
      setAgents(result.subagents);
      setRuntime(await fetchSubagentRuntime().catch(() => null));
      setNotice(language === 'zh' ? '注册表已重新加载。' : 'Registry reloaded.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [language]);

  const removeAgent = useCallback(
    async (agent: SubagentDetail) => {
      const confirmed = window.confirm(
        language === 'zh'
          ? `删除子 Agent「${agent.displayName}」？`
          : `Delete subagent "${agent.displayName}"?`,
      );
      if (!confirmed) {
        return;
      }
      setActionId(agent.id);
      setError('');
      try {
        await deleteSubagent(agent.id);
        setAgents((current) =>
          current.filter((item) => item.id !== agent.id && item.name !== agent.name),
        );
        setDetail(null);
        setNotice(language === 'zh' ? '子 Agent 已删除。' : 'Subagent deleted.');
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setActionId('');
      }
    },
    [language],
  );

  return (
    <div className="feature-content subagents-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={language === 'zh' ? '搜索子 Agent' : 'Search subagents'}
          />
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setRegisterOpen(true)}
        >
          <Plus size={16} />
          {language === 'zh' ? '注册子 Agent' : 'Register'}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={loading}
          onClick={() => void rebuildRegistry()}
        >
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '重载' : 'Reload'}
        </button>
      </div>
      <p className="feature-hint">
        {language === 'zh'
          ? `共 ${agents.length} 个子 Agent。GUI 对话请求会携带 subagent_enabled=true；profile 启停和 Supervisor 仍由后端做最终准入。`
          : `${agents.length} subagents. GUI chat sends subagent_enabled=true; profile enablement and Supervisor still gate dispatch on the backend.`}
      </p>
      {notice && <p className="feature-hint">{notice}</p>}
      {error && <p className="feature-error">{error}</p>}
      {supervisor && (
        <section className={`subagent-supervisor-card ${supervisor.enabled ? '' : 'disabled'}`}>
          <header>
            <span>
              <ShieldCheck size={17} />
              <strong>
                {language === 'zh' ? 'Supervisor 准入限制' : 'Supervisor admission'}
              </strong>
            </span>
            <em>{supervisor.enabled ? (language === 'zh' ? '已开启' : 'Enabled') : (language === 'zh' ? '已关闭' : 'Disabled')}</em>
          </header>
          <div className="subagent-supervisor-grid">
            <InfoRow
              label={language === 'zh' ? '总运行' : 'Active total'}
              value={formatSubagentLimit(
                supervisorTotalActive,
                supervisor.limits.maxActiveTotal,
              )}
            />
            <InfoRow
              label={language === 'zh' ? '单会话' : 'Per session'}
              value={limitValue(supervisor.limits.maxActivePerSession, language)}
            />
            <InfoRow
              label={language === 'zh' ? '单 Agent' : 'Per agent'}
              value={limitValue(supervisor.limits.maxActivePerAgent, language)}
            />
            <InfoRow
              label={language === 'zh' ? '最大深度' : 'Max depth'}
              value={limitValue(supervisor.limits.maxDepth, language)}
            />
            <InfoRow
              label="TTL"
              value={formatSecondsLimit(supervisor.limits.taskTtlSeconds, language)}
            />
            <InfoRow
              label={language === 'zh' ? '拒绝策略' : 'Reject strategy'}
              value={supervisor.rejectStrategy || supervisor.queueMode || '-'}
            />
          </div>
        </section>
      )}
      <div className="subagent-workbench">
        <section className="subagent-map-pane" style={subagentMapStyle}>
          <header className="subagent-map-header">
            <div>
              <span>{language === 'zh' ? '分身地图' : 'Agent map'}</span>
              <strong>{gameCodingDisplayName(gameCodingMap, language)}</strong>
            </div>
            <em>{language === 'zh' ? '员工席位' : 'Staff seats'} {filteredAgents.length}</em>
          </header>
          <div className="subagent-map-command">
            <span className="subagent-command-avatar">
              <ShieldCheck size={18} />
            </span>
            <div>
              <strong>{language === 'zh' ? 'Supervisor 调度台' : 'Supervisor desk'}</strong>
              <small>
                {supervisor
                  ? formatSubagentLimit(supervisorTotalActive, supervisor.limits.maxActiveTotal)
                  : language === 'zh'
                    ? '等待运行信息'
                    : 'Runtime pending'}
              </small>
            </div>
          </div>
          <div className="result-stack subagent-map-grid">
            {filteredAgents.map((agent, index) => {
              const agentRuntime = runtimeByAgent.get(agent.name) ?? {};
              const runningCount = subagentAgentActiveCount(
                supervisor,
                agent,
                Number(agentRuntime.current_running ?? 0),
              );
              const atAgentLimit = subagentAtAgentLimit(supervisor, agent, runningCount);
              const active =
                detail != null &&
                (detail.id === agent.id || detail.name === agent.name);
              const characterPreset = characterPresetForAgent(
                agent,
                index,
                gameCodingSettings,
              );
              return (
                <article
                  className={`result-card subagent subagent-agent-node ${agent.enabled ? '' : 'disabled'} ${agent.validationStatus} ${atAgentLimit ? 'at-limit' : ''} ${active ? 'selected' : ''} ${runningCount > 0 ? 'running' : ''}`}
                  key={agent.id}
                >
                  <button
                    className="subagent-card-main"
                    type="button"
                    onClick={() => void openDetail(agent)}
                  >
                    <span className="subagent-avatar-frame">
                      <img
                        src={gameCodingCharacterImageForAgent(
                          agent,
                          index,
                          gameCodingSettings,
                        )}
                        alt=""
                        aria-hidden="true"
                      />
                    </span>
                    <div>
                      <h3>{agent.displayName || agent.name}</h3>
                      <p>{agent.description || (language === 'zh' ? '暂无描述' : 'No description')}</p>
                      <small>
                        {gameCodingDisplayName(characterPreset, language)}
                        {' · '}
                        {gameCodingRoleText(characterPreset, language)}
                        {' · '}
                        {agent.name}
                        {agent.source ? ` · ${agent.source}` : ''}
                        {runningCount > 0 ? ` · ${language === 'zh' ? '运行中' : 'running'} ${runningCount}` : ''}
                        {atAgentLimit ? ` · ${language === 'zh' ? '达到限制' : 'at limit'}` : ''}
                      </small>
                      {agent.tags.length > 0 && (
                        <span className="subagent-tags">
                          {agent.tags.slice(0, 5).map((tag) => (
                            <em key={tag}>{tag}</em>
                          ))}
                        </span>
                      )}
                    </div>
                  </button>
                  <span className={`subagent-status ${agent.validationStatus}`}>
                    {agent.validationStatus === 'invalid'
                      ? language === 'zh'
                        ? '配置异常'
                        : 'Invalid'
                      : agent.enabled
                        ? language === 'zh'
                          ? '已启用'
                          : 'Enabled'
                        : language === 'zh'
                          ? '已关闭'
                          : 'Disabled'}
                  </span>
                  <button
                    className={`skill-toggle ${agent.enabled ? 'on' : ''}`}
                    type="button"
                    disabled={actionId === agent.id || actionId === agent.name}
                    onClick={() => void toggleAgent(agent)}
                  >
                    {actionId === agent.id || actionId === agent.name ? (
                      <LoaderCircle size={14} />
                    ) : agent.enabled ? (
                      <CheckCircle2 size={14} />
                    ) : (
                      <Circle size={14} />
                    )}
                    {agent.enabled
                      ? language === 'zh'
                        ? '禁用'
                        : 'Disable'
                      : language === 'zh'
                        ? '启用'
                        : 'Enable'}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
        <section className="subagent-detail-pane">
          {detailLoading ? (
            <div className="feature-loading">
              <LoaderCircle size={20} />
              {language === 'zh' ? '正在加载子 Agent 详情...' : 'Loading subagent detail...'}
            </div>
          ) : detail ? (
            <SubagentDetailDialog
              language={language}
              detail={detail}
              usage={usage}
              capabilities={capabilities}
              supervisor={supervisor}
              actionId={actionId}
              onClose={() => {
                setDetail(null);
                setUsage(null);
              }}
              onSaved={(updated) => {
                setDetail(updated);
                updateAgent(updated);
                setNotice(language === 'zh' ? '子 Agent 配置已保存。' : 'Subagent saved.');
              }}
              onError={setError}
              onDelete={() => void removeAgent(detail)}
              onActionStart={setActionId}
            />
          ) : (
            <div className="subagent-empty-detail">
              <Network size={24} />
              <strong>{language === 'zh' ? '选择一个子 Agent' : 'Select a subagent'}</strong>
              <p>
                {language === 'zh'
                  ? '在右侧直接查看运行信息、编辑基础配置和原始注册配置。'
                  : 'Open a profile to inspect runtime details and edit its registry config.'}
              </p>
            </div>
          )}
        </section>
      </div>
      {loading && agents.length === 0 && (
        <div className="feature-loading">
          <LoaderCircle size={20} />
          {language === 'zh' ? '正在加载子 Agent 注册表...' : 'Loading subagent registry...'}
        </div>
      )}
      {registerOpen && (
        <SubagentRegisterDialog
          language={language}
          templates={templates}
          onClose={() => setRegisterOpen(false)}
          onRegistered={(created) => {
            updateAgent(created);
            setRegisterOpen(false);
            setDetail(created);
            setNotice(language === 'zh' ? '子 Agent 已注册。' : 'Subagent registered.');
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function SubagentDetailDialog({
  language,
  detail,
  usage,
  capabilities,
  supervisor,
  actionId,
  onClose,
  onSaved,
  onError,
  onDelete,
  onActionStart,
}: {
  language: AppLanguage;
  detail: SubagentDetail;
  usage: SubagentUsageResult | null;
  capabilities: SubagentCapabilities | null;
  supervisor: SubagentSupervisorSnapshot | null;
  actionId: string;
  onClose: () => void;
  onSaved: (detail: SubagentDetail) => void;
  onError: (message: string) => void;
  onDelete: () => void;
  onActionStart: (agentId: string) => void;
}) {
  const [displayName, setDisplayName] = useState(detail.displayName);
  const [description, setDescription] = useState(detail.description);
  const [tags, setTags] = useState(detail.tags.join(', '));
  const [rawText, setRawText] = useState(() => formatJson(detail.rawConfig));
  const [validation, setValidation] = useState<SubagentValidationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRuntimeLog, setShowRuntimeLog] = useState(false);

  useEffect(() => {
    setDisplayName(detail.displayName);
    setDescription(detail.description);
    setTags(detail.tags.join(', '));
    setRawText(formatJson(detail.rawConfig));
    setValidation(null);
    setShowRuntimeLog(false);
  }, [detail]);

  const runtimeStats =
    usage?.byAgent[detail.name] ??
    usage?.byAgent[detail.id] ??
    {};
  const runtimeLastError = displayableRuntimeLastError(runtimeStats.last_error);
  const runtimeFailureCount = Number(runtimeStats.failure_count ?? 0);
  const runtimeSuccessCount = Number(runtimeStats.success_count ?? 0);
  const runtimeLastCalledAt = optionalDisplayText(runtimeStats.last_called_at);
  const runningCount = subagentAgentActiveCount(
    supervisor,
    detail,
    Number(runtimeStats.current_running ?? 0),
  );
  const workerDefaults = subagentWorkerDefaultsFromConfig(detail.rawConfig);

  const saveBasics = async () => {
    setSaving(true);
    onActionStart(detail.id);
    onError('');
    try {
      const updated = await patchSubagent(detail.id, {
        display_name: displayName.trim(),
        description: description.trim(),
        tags: tagsFromText(tags),
      });
      onSaved(updated);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setSaving(false);
      onActionStart('');
    }
  };

  const validateRaw = async () => {
    const parsed = parseJsonObject(rawText);
    if (!parsed.ok) {
      setValidation({
        ok: false,
        errors: [{ field: 'raw_config', message: parsed.error, severity: 'error' }],
        effectiveConfig: {},
      });
      return null;
    }
    const result = await validateSubagent(parsed.value);
    setValidation(result);
    return result.ok ? parsed.value : null;
  };

  const saveRaw = async () => {
    setSaving(true);
    onActionStart(detail.id);
    onError('');
    try {
      const parsed = await validateRaw();
      if (!parsed) {
        return;
      }
      const updated = await patchSubagent(detail.id, { raw_config: parsed });
      onSaved(updated);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setSaving(false);
      onActionStart('');
    }
  };

  return (
      <section className="subagent-detail-dialog">
        <header>
          <Network size={18} />
          <span>
            <strong>{detail.displayName || detail.name}</strong>
            <small>{detail.name}</small>
          </span>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="subagent-detail-grid">
          <section className="subagent-edit-card">
            <h3>{language === 'zh' ? '基础配置' : 'Basics'}</h3>
            <label className="settings-field">
              <span>{language === 'zh' ? '显示名称' : 'Display name'}</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
            </label>
            <label className="settings-field">
              <span>{language === 'zh' ? '描述' : 'Description'}</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
            </label>
            <label className="settings-field">
              <span>Tags</span>
              <input
                value={tags}
                onChange={(event) => setTags(event.currentTarget.value)}
                placeholder="code, worker"
              />
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={saving || actionId === detail.id}
              onClick={() => void saveBasics()}
            >
              {saving ? <LoaderCircle size={14} /> : <Check size={14} />}
              {language === 'zh' ? '保存基础配置' : 'Save basics'}
            </button>
          </section>
          <section className="subagent-edit-card">
            <h3>{language === 'zh' ? '运行信息' : 'Runtime'}</h3>
            <InfoRow
              label={language === 'zh' ? '状态' : 'Status'}
              value={subagentStatusLabel(detail, language)}
            />
            <InfoRow
              label={language === 'zh' ? '注册表' : 'Registry'}
              value={detail.registryPath || '-'}
            />
            <InfoRow
              label={language === 'zh' ? '模型' : 'Model'}
              value={
                detail.inheritsGlobalModel
                  ? language === 'zh'
                    ? '继承全局模型'
                    : 'Inherits global model'
                  : [detail.provider, detail.model].filter(Boolean).join(' / ') || '-'
              }
            />
            <InfoRow
              label={language === 'zh' ? '当前运行' : 'Running'}
              value={String(runningCount)}
            />
            {workerDefaults.runtimeProfile && (
              <InfoRow
                label={language === 'zh' ? 'Worker profile' : 'Worker profile'}
                value={workerDefaults.runtimeProfile}
              />
            )}
            {workerDefaults.lane && (
              <InfoRow
                label={language === 'zh' ? 'Worker lane' : 'Worker lane'}
                value={workerDefaults.lane}
              />
            )}
            {workerDefaults.exitCondition && (
              <InfoRow
                label={language === 'zh' ? '退出条件' : 'Exit condition'}
                value={workerDefaults.exitCondition}
              />
            )}
            <InfoRow
              label={language === 'zh' ? '总调用' : 'Total calls'}
              value={String(runtimeStats.total ?? 0)}
            />
            <div className="subagent-runtime-log-control">
              <button
                type="button"
                onClick={() => setShowRuntimeLog((current) => !current)}
              >
                <Clock3 size={14} />
                {showRuntimeLog
                  ? language === 'zh'
                    ? '隐藏运行日志'
                    : 'Hide runtime log'
                  : language === 'zh'
                    ? '查看运行日志'
                    : 'View runtime log'}
                {runtimeFailureCount > 0 && <b>{runtimeFailureCount}</b>}
              </button>
            </div>
            {showRuntimeLog && (
              <div className="subagent-runtime-log">
                <InfoRow
                  label={language === 'zh' ? '成功' : 'Succeeded'}
                  value={String(runtimeSuccessCount)}
                />
                <InfoRow
                  label={language === 'zh' ? '失败' : 'Failed'}
                  value={String(runtimeFailureCount)}
                />
                <InfoRow
                  label={language === 'zh' ? '最近调用' : 'Last called'}
                  value={runtimeLastCalledAt || '-'}
                />
                {runtimeLastError ? (
                  <div className="subagent-runtime-last-failure">
                    <span>
                      {language === 'zh' ? '最近失败' : 'Latest failure'}
                    </span>
                    <strong>{runtimeLastError}</strong>
                  </div>
                ) : (
                  <p className="feature-hint">
                    {language === 'zh' ? '暂无失败记录。' : 'No failures recorded.'}
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
        {supervisor && (
          <section className="subagent-edit-card">
            <h3>{language === 'zh' ? 'Supervisor 限制' : 'Supervisor limits'}</h3>
            <div className="subagent-detail-grid compact">
              <InfoRow
                label={language === 'zh' ? '准入状态' : 'Admission'}
                value={supervisor.enabled ? (language === 'zh' ? '开启' : 'Enabled') : (language === 'zh' ? '关闭' : 'Disabled')}
              />
              <InfoRow
                label={language === 'zh' ? '当前 Agent' : 'This agent'}
                value={formatSubagentLimit(
                  runningCount,
                  supervisor.limits.maxActivePerAgent,
                )}
              />
              <InfoRow
                label={language === 'zh' ? '全部运行' : 'Total active'}
                value={formatSubagentLimit(
                  subagentSupervisorTotalActive(supervisor),
                  supervisor.limits.maxActiveTotal,
                )}
              />
              <InfoRow
                label={language === 'zh' ? '递归深度' : 'Depth'}
                value={
                  supervisor.depth == null
                    ? limitValue(supervisor.limits.maxDepth, language)
                    : formatSubagentLimit(supervisor.depth, supervisor.limits.maxDepth)
                }
              />
              <InfoRow
                label={language === 'zh' ? '队列模式' : 'Queue mode'}
                value={supervisor.queueMode || '-'}
              />
              <InfoRow
                label={language === 'zh' ? '拒绝策略' : 'Reject strategy'}
                value={supervisor.rejectStrategy || '-'}
              />
            </div>
            {supervisor.blockedTools.length > 0 && (
              <div className="subagent-chip-list">
                {supervisor.blockedTools.map((tool) => (
                  <span key={tool}>{tool}</span>
                ))}
              </div>
            )}
          </section>
        )}
        <div className="subagent-detail-grid">
          <section className="subagent-edit-card">
            <h3>{language === 'zh' ? '能力' : 'Capabilities'}</h3>
            <div className="subagent-chip-list">
              {(detail.tools.length ? detail.tools : [detail.toolProfile || 'none']).map((tool) => (
                <span key={`tool-${tool}`}>{tool}</span>
              ))}
            </div>
            {detail.skills.length > 0 && (
              <div className="subagent-chip-list">
                {detail.skills.map((skill) => (
                  <span key={`skill-${skill}`}>{skill}</span>
                ))}
              </div>
            )}
            {capabilities && (
              <p className="feature-hint">
                {language === 'zh'
                  ? `后端可用工具 ${capabilities.tools.length} 个，skills ${capabilities.skills.length} 个。`
                  : `${capabilities.tools.length} tools and ${capabilities.skills.length} skills available.`}
              </p>
            )}
          </section>
          <section className="subagent-edit-card">
            <h3>{language === 'zh' ? '路由/权限' : 'Routing / Permissions'}</h3>
            <pre className="subagent-mini-json">{formatJson({
              routing: detail.routing,
              permission_policy: detail.permissionPolicy,
              workdir_policy: detail.workdirPolicy,
              concurrency_limit: detail.concurrencyLimit,
              timeout_seconds: detail.timeoutSeconds,
            })}</pre>
          </section>
        </div>
        <section className="subagent-edit-card">
          <h3>{language === 'zh' ? '原始注册配置' : 'Raw registry config'}</h3>
          <p className="feature-hint">
            {language === 'zh'
              ? '保存前以后端校验为准；payload.tools 不能包含 subagent 或管理类工具。'
              : 'Backend validation is authoritative; payload.tools cannot include subagent or management tools.'}
          </p>
          <textarea
            className="subagent-raw-editor"
            value={rawText}
            spellCheck={false}
            onChange={(event) => setRawText(event.currentTarget.value)}
          />
          {validation && (
            <div className={`subagent-validation ${validation.ok ? 'ok' : 'invalid'}`}>
              <strong>
                {validation.ok
                  ? language === 'zh'
                    ? '校验通过'
                    : 'Valid'
                  : language === 'zh'
                    ? '校验失败'
                    : 'Invalid'}
              </strong>
              {validation.errors.map((item, index) => (
                <p key={`${item.field}-${index}`}>
                  {item.field} [{item.severity}]: {item.message}
                </p>
              ))}
            </div>
          )}
          <div className="subagent-dialog-actions">
            <button type="button" onClick={() => void validateRaw()}>
              <CheckCircle2 size={14} />
              {language === 'zh' ? '校验' : 'Validate'}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={saving || actionId === detail.id}
              onClick={() => void saveRaw()}
            >
              {saving ? <LoaderCircle size={14} /> : <Upload size={14} />}
              {language === 'zh' ? '保存 Raw 配置' : 'Save raw config'}
            </button>
            <button type="button" disabled={saving} onClick={onDelete}>
              <Trash2 size={14} />
              {language === 'zh' ? '删除' : 'Delete'}
            </button>
          </div>
        </section>
      </section>
  );
}

function SubagentRegisterDialog({
  language,
  templates,
  onClose,
  onRegistered,
  onError,
}: {
  language: AppLanguage;
  templates: SubagentTemplate[];
  onClose: () => void;
  onRegistered: (detail: SubagentDetail) => void;
  onError: (message: string) => void;
}) {
  const firstTemplate = templates[0];
  const [mode, setMode] = useState<'template' | 'path'>('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState(firstTemplate?.id ?? '');
  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? firstTemplate;
  const [rawText, setRawText] = useState(() =>
    formatJson(selectedTemplate?.rawConfig ?? {
      name: 'my-subagent',
      description: 'Local child agent.',
      enabled: true,
      tags: ['local'],
      payload: { tools: [] },
    }),
  );
  const [sourcePath, setSourcePath] = useState('');
  const [replace, setReplace] = useState(false);
  const [validation, setValidation] = useState<SubagentValidationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (selectedTemplate) {
      setRawText(formatJson(selectedTemplate.rawConfig));
      setValidation(null);
    }
  }, [selectedTemplate]);

  const validateRaw = async () => {
    const parsed = parseJsonObject(rawText);
    if (!parsed.ok) {
      setValidation({
        ok: false,
        errors: [{ field: 'raw_config', message: parsed.error, severity: 'error' }],
        effectiveConfig: {},
      });
      return null;
    }
    const result = await validateSubagent(parsed.value);
    setValidation(result);
    return result.ok ? parsed.value : null;
  };

  const submit = async () => {
    setSubmitting(true);
    onError('');
    try {
      const rawConfig = mode === 'template' ? await validateRaw() : undefined;
      if (mode === 'template' && !rawConfig) {
        return;
      }
      const created = await registerSubagent({
        rawConfig: rawConfig ?? undefined,
        sourcePath: mode === 'path' ? sourcePath : undefined,
        replace,
      });
      onRegistered(created);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="subagent-register-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <Plus size={18} />
          <strong>{language === 'zh' ? '注册子 Agent' : 'Register subagent'}</strong>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="segmented-control">
          <button
            type="button"
            className={mode === 'template' ? 'active' : ''}
            onClick={() => setMode('template')}
          >
            {language === 'zh' ? '模板 / Raw' : 'Template / Raw'}
          </button>
          <button
            type="button"
            className={mode === 'path' ? 'active' : ''}
            onClick={() => setMode('path')}
          >
            {language === 'zh' ? '本地路径' : 'Local path'}
          </button>
        </div>
        {mode === 'template' ? (
          <>
            {templates.length > 0 && (
              <select
                className="subagent-select"
                value={selectedTemplateId}
                onChange={(event) => setSelectedTemplateId(event.currentTarget.value)}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            )}
            <p className="feature-hint">
              {language === 'zh'
                ? '注册前会请求后端校验；payload.tools 不能包含 subagent 或管理类工具。'
                : 'Registration is validated by the backend; payload.tools cannot include subagent or management tools.'}
            </p>
            <textarea
              className="subagent-raw-editor"
              value={rawText}
              spellCheck={false}
              onChange={(event) => setRawText(event.currentTarget.value)}
            />
          </>
        ) : (
          <label className="settings-field">
            <span>{language === 'zh' ? 'agent.json 或包目录路径' : 'agent.json or package path'}</span>
            <input
              value={sourcePath}
              onChange={(event) => setSourcePath(event.currentTarget.value)}
              placeholder="C:\Users\...\agent.json"
            />
          </label>
        )}
        <label className="settings-check">
          <input
            type="checkbox"
            checked={replace}
            onChange={(event) => setReplace(event.currentTarget.checked)}
          />
          <span>{language === 'zh' ? '允许覆盖同名子 Agent' : 'Replace existing subagent'}</span>
        </label>
        {validation && (
          <div className={`subagent-validation ${validation.ok ? 'ok' : 'invalid'}`}>
            <strong>{validation.ok ? (language === 'zh' ? '校验通过' : 'Valid') : (language === 'zh' ? '校验失败' : 'Invalid')}</strong>
            {validation.errors.map((item, index) => (
              <p key={`${item.field}-${index}`}>
                {item.field} [{item.severity}]: {item.message}
              </p>
            ))}
          </div>
        )}
        <div className="subagent-dialog-actions">
          {mode === 'template' && (
            <button type="button" onClick={() => void validateRaw()}>
              <CheckCircle2 size={14} />
              {language === 'zh' ? '校验' : 'Validate'}
            </button>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={submitting || (mode === 'path' && !sourcePath.trim())}
            onClick={() => void submit()}
          >
            {submitting ? <LoaderCircle size={14} /> : <Plus size={14} />}
            {language === 'zh' ? '注册' : 'Register'}
          </button>
        </div>
      </section>
    </div>
  );
}

function subagentSummaryFromDetail(agent: SubagentDetail | SubagentListItem): SubagentListItem {
  return {
    id: agent.id,
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    enabled: agent.enabled,
    tags: agent.tags,
    source: agent.source,
    registryPath: agent.registryPath,
    version: agent.version,
    lastLoadedAt: agent.lastLoadedAt,
    validationStatus: agent.validationStatus,
    error: agent.error,
  };
}

function subagentStatusLabel(agent: SubagentListItem, language: AppLanguage) {
  if (agent.validationStatus === 'invalid') {
    return language === 'zh' ? '配置异常' : 'Invalid';
  }
  if (!agent.enabled) {
    return language === 'zh' ? '已关闭' : 'Disabled';
  }
  return language === 'zh' ? '已启用' : 'Enabled';
}

function subagentWorkerDefaultsFromConfig(config: Record<string, unknown>) {
  const worker = asRecord(config.worker);
  const defaults = asRecord(config.defaults);
  return {
    runtimeProfile:
      nonEmptyString(
        config.runtime_profile ??
          config.runtimeProfile ??
          worker.runtime_profile ??
          worker.runtimeProfile ??
          defaults.runtime_profile ??
          defaults.runtimeProfile,
      ) ?? '',
    lane:
      nonEmptyString(config.lane ?? worker.lane ?? defaults.lane) ?? '',
    exitCondition:
      nonEmptyString(
        config.exit_condition ??
          config.exitCondition ??
          worker.exit_condition ??
          worker.exitCondition ??
          defaults.exit_condition ??
          defaults.exitCondition,
      ) ?? '',
  };
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

function subagentAtAgentLimit(
  supervisor: SubagentSupervisorSnapshot | null | undefined,
  agent: Pick<SubagentListItem, 'id' | 'name'>,
  runningCount: number,
) {
  if (!supervisor?.enabled || supervisor.limits.maxActivePerAgent == null) {
    return false;
  }
  return subagentAgentActiveCount(supervisor, agent, runningCount) >=
    supervisor.limits.maxActivePerAgent;
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

function tagsFromText(value: string) {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function parseJsonObject(value: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string } {
  try {
    const decoded = JSON.parse(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return { ok: false, error: 'JSON must be an object' };
    }
    return { ok: true, value: decoded as Record<string, unknown> };
  } catch (caught) {
    return { ok: false, error: errorMessage(caught) };
  }
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function nonEmptyString(value: unknown) {
  const text = value == null ? '' : String(value).trim();
  return text || undefined;
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function displayableRuntimeLastError(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  if (
    /Client error '404 Not Found'/i.test(text) &&
    /\/v1\/turns\/[^/\s]+\/stop/i.test(text)
  ) {
    return '';
  }
  return text;
}

function optionalDisplayText(value: unknown) {
  return String(value ?? '').trim();
}
