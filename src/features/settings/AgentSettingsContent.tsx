import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import type { AgentConnection, AgentInfo, AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, AppSettingsState, BackendCapabilities, SkillDetail, SkillSummary } from '../../types';
import type { AgentCall } from '../agents/agentConversationBackend';
import { useAgentChatPreferences } from '../agents/agentChatPreferences';
import { agentErrorText } from '../agents/agentErrorText';
import { PluginManagementPanel } from '../plugins/PluginManagementPanel';
import { CacheMaintenancePanel, McpServersPanel } from '../SettingsView';
import { ModelsSettingsPanel, type ModelSettingsConfig } from './ModelsSettingsPanel';
import { SettingsPersonalizationPanel } from './SettingsPersonalizationPanel';
import { SettingsCard, SettingsInput, SettingsSelect } from './SettingsControls';
import { SettingsHostContext } from './SettingsHostContext';
import { createAgentSettingsHost } from './agentSettingsHost';
import { SandboxSettingsPanel } from './SandboxSettingsPanel';
import { AgentArchivesPanel } from './AgentArchivesPanel';
import type { InstructionsSource } from './GlobalInstructionsPanel';
import type { VisibleSettingsSection } from './settingsNavigation';

const emptySkills: SkillSummary[] = [];
export function AgentSettingsContent({ connection, section, language, settings, onSettingsChange, visualInputEnabled, onNotify, initialPluginTab }: {
  connection: AgentConnection; section: VisibleSettingsSection; language: AppLanguage; settings: AppSettingsState;
  onSettingsChange: (update: (settings: AppSettingsState) => AppSettingsState) => void;
  visualInputEnabled: boolean; onNotify: (message: string) => void; initialPluginTab: 'plugins' | 'skills';
}) {
  const zh = language === 'zh';
  const [info, setInfo] = useState<AgentInfo>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const call = useCallback<AgentCall>(async (operation, input) => {
    const result = await window.cardbushDesktop!.agents!.call(connection.id, operation, input);
    if (['instructions.save', 'plugins.install', 'plugins.uninstall', 'plugins.connections.save', 'mcp.configure', 'mcp.remove', 'projects.save', 'projects.default', 'projects.remove'].includes(operation)
      || (operation === 'product.command' && /\.update$|^maintenance\./.test(String(input?.kind)))) {
      window.dispatchEvent(new CustomEvent('cardbush:agent-settings-updated', { detail: connection.id }));
    }
    return result as never;
  }, [connection.id]);
  useEffect(() => {
    let alive = true; setError(''); setInfo(undefined);
    void window.cardbushDesktop!.agents!.connect(connection.id).then(value => { if (alive) setInfo(value); }, error => { if (alive) setError(agentErrorText(error)); });
    return () => { alive = false; };
  }, [connection.id, retry]);
  const host = useMemo(() => createAgentSettingsHost(call, info?.capabilities.sharedSettings === true), [call, info]);
  const instructions = useMemo<InstructionsSource>(() => ({ read: () => call('instructions.get'), save: (content, revision) => call('instructions.save', { content, revision }) }), [call]);
  const [preferences, setPreferences] = useAgentChatPreferences(connection.id, '');
  const reloadSkills = useCallback(async () => (await call<{ skills: SkillSummary[] }>('conversation.catalog')).skills.map(skill => ({ ...skill, logoPath: undefined, logoDarkPath: undefined })), [call]);
  const loadSkill = useCallback(async (name: string) => ({ ...await call<SkillDetail>('conversation.catalog', { action: 'read', name }), logoPath: undefined, logoDarkPath: undefined }), [call]);
  const disabledSkills = useMemo(() => new Set(preferences.disabledSkills), [preferences.disabledSkills]);
  const capabilities = { mcpServers: true, maintenanceConversationHistoryClear: true, maintenanceLogsCacheClear: true } as BackendCapabilities;
  if (error) return <div role="alert" className="settings-inline-error">{error}<button className="secondary-button" onClick={() => setRetry(value => value + 1)}>{zh ? '重试连接' : 'Retry connection'}</button></div>;
  if (!info) return <p role="status">{zh ? '正在连接 Agent…' : 'Connecting to Agent…'}</p>;
  return <SettingsHostContext.Provider value={host}>
    {section === 'runtime' && (info.capabilities.sandboxSettings ? <SandboxSettingsPanel language={language}/>
      : <SettingsCard title={zh ? '命令沙盒' : 'Command sandbox'}><p>{zh ? '请更新此 Agent 服务，以在设置中管理沙盒。' : 'Update this Agent service to manage its sandbox in Settings.'}</p></SettingsCard>)}
    {section === 'models' && <AgentModels call={call} language={language} name={connection.name}
      visualInputAvailable={info.capabilities.sharedConversation === true} visualInputEnabled={preferences.visionEnabled ?? visualInputEnabled}
      visionControl={<SettingsSelect name="agent-vision-mode" title={zh ? '视觉功能' : 'Vision input'}
        subtitle={info.capabilities.sharedConversation ? (zh ? '默认使用本机偏好，也可以仅对此 Agent 调整。需选择支持视觉输入的模型。' : 'Inherit this device’s preference, or override it for this Agent. Requires a vision-capable model.') : (zh ? '请更新 Agent 服务以启用视觉输入。' : 'Update this Agent service to enable vision input.')}
        disabled={!info.capabilities.sharedConversation} value={!info.capabilities.sharedConversation ? 'off' : preferences.visionEnabled === undefined ? 'inherit' : preferences.visionEnabled ? 'on' : 'off'}
        onChange={value => setPreferences(current => ({ ...current, visionEnabled: value === 'inherit' ? undefined : value === 'on' }))}>
        <option value="inherit">{zh ? '跟随本机' : 'Follow this device'} · {visualInputEnabled ? zh ? '开启' : 'On' : zh ? '关闭' : 'Off'}</option>
        <option value="on">{zh ? '仅此 Agent 开启' : 'On for this Agent'}</option><option value="off">{zh ? '仅此 Agent 关闭' : 'Off for this Agent'}</option>
      </SettingsSelect>}/>}
    {section === 'profile' && <><p className="settings-muted">{zh ? '交互与显示偏好在所有环境共用；下方 AGENTS.md 保存到当前 Agent。' : 'Interaction and display preferences are shared; AGENTS.md below belongs to this Agent.'}</p>
      {!info.capabilities.sharedSettings && <p role="status">{zh ? '更新 Agent 服务后可共用本机的回复风格。' : 'Update the Agent service to share the response style from this device.'}</p>}
      <SettingsPersonalizationPanel language={language} settings={settings} onSettingsChange={onSettingsChange} reasoningStreamAvailable
        instructionsSource={instructions} responseStyleAvailable={info.capabilities.sharedSettings === true}/></>}
    {section === 'mcp' && <PluginManagementPanel language={language} initialTab={initialPluginTab} skills={emptySkills} disabledSkillNames={disabledSkills}
      onToggleSkill={(name, enabled) => setPreferences(current => ({ ...current, disabledSkills: enabled ? current.disabledSkills.filter(item => item !== name) : [...new Set([...current.disabledSkills, name])] }))}
      onReloadSkills={reloadSkills} onLoadSkillDetail={loadSkill} onNotify={onNotify}
      renderMcp={serverId => <McpServersPanel language={language} initialServerId={serverId} capabilities={capabilities} onNotify={onNotify}/>}/>}
    {section === 'projects' && <AgentProjects call={call} language={language}/>}
    {section === 'cache' && <div className="settings-stack">
      {info.capabilities.conversationManagement && <AgentArchivesPanel call={call} connectionId={connection.id} language={language} onNotify={onNotify}/>}
      <CacheMaintenancePanel language={language} capabilities={capabilities} runtimeBusy={false} onNotify={onNotify}
        scopeName={connection.name} clear={target => call('product.command', { kind: target === 'conversation' ? 'maintenance.clear_conversations' : target === 'logs' ? 'maintenance.clear_logs_cache' : 'maintenance.clear_cache' })}/>
    </div>}
    {section === 'diagnostics' && <SettingsCard title={connection.name}><dl className="settings-agent-info"><dt>{zh ? '运行平台' : 'Platform'}</dt><dd>{info.platform}</dd><dt>{zh ? '连接方式' : 'Connection'}</dt><dd>{connection.sshTunnel ? 'SSH' : 'HTTP / HTTPS'}</dd><dt>{zh ? '设置兼容性' : 'Settings support'}</dt><dd>{info.capabilities.sharedSettings ? zh ? '已支持共享偏好与插件设置' : 'Shared preferences and plugin settings supported' : zh ? '可管理基本设置，更新服务可获得完整支持' : 'Basic settings available; update the service for full support'}</dd></dl></SettingsCard>}
  </SettingsHostContext.Provider>;
}

function AgentModels({ call, language, name, ...vision }: { call: AgentCall; language: AppLanguage; name: string } & Pick<ComponentProps<typeof ModelsSettingsPanel>, 'visionControl' | 'visualInputAvailable' | 'visualInputEnabled'>) {
  const [models, setModels] = useState<ModelSettingsConfig>(); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => setModels(await call('product.command', { kind: 'models.get' })), [call]);
  useEffect(() => { let alive = true; setError(''); void call<ModelSettingsConfig>('product.command', { kind: 'models.get' }).then(value => { if (alive) setModels(value); }, error => { if (alive) setError(agentErrorText(error)); }); return () => { alive = false; }; }, [call, revision]);
  if (error) return <p role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>{language === 'zh' ? '重试' : 'Retry'}</button></p>;
  if (!models) return <p role="status">{language === 'zh' ? '正在加载模型…' : 'Loading models…'}</p>;
  return <ModelsSettingsPanel {...vision} language={language} scopeName={name} models={models} onRefresh={refresh} onVisualInputEnabledChange={() => {}}
    onSave={config => call('product.command', { kind: 'models.update', config })}/>;
}

function AgentProjects({ call, language }: { call: AgentCall; language: AppLanguage }) {
  const zh = language === 'zh';
  const [projects, setProjects] = useState<{ projects: AgentProject[]; defaultProjectId: string | null }>({ projects: [], defaultProjectId: null });
  const [name, setName] = useState(''); const [path, setPath] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setProjects(await call('projects.list')), [call]);
  useEffect(() => { let alive = true; void call<typeof projects>('projects.list').then(value => { if (alive) setProjects(value); }, error => { if (alive) setError(agentErrorText(error)); }); return () => { alive = false; }; }, [call]);
  async function act(fn: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(''); try { await fn(); await refresh(); } catch (error) { setError(agentErrorText(error)); } finally { setBusy(false); } }
  return <SettingsCard title={zh ? '绑定项目' : 'Projects'}>
    {error && <p role="alert">{error}</p>}{projects.projects.map(project => <div className="settings-project-row" key={project.id}><div><strong>{project.name}</strong><small>{project.path}</small></div>
      <button disabled={busy || project.id === projects.defaultProjectId} onClick={() => void act(() => call('projects.default', { id: project.id }))}>{project.id === projects.defaultProjectId ? zh ? '默认' : 'Default' : zh ? '设为默认' : 'Make default'}</button>
      <button disabled={busy} onClick={() => void act(() => call('projects.remove', { id: project.id }))}>{zh ? '移除' : 'Remove'}</button></div>)}
    <form className="settings-stack" onSubmit={event => { event.preventDefault(); void act(async () => { await call('projects.save', { name: name.trim(), path: path.trim() }); setName(''); setPath(''); }); }}>
      <SettingsInput label={zh ? '项目名称' : 'Project name'} value={name} onChange={setName}/><SettingsInput label={zh ? 'Agent 主机上的目录' : 'Directory on the Agent host'} value={path} onChange={setPath}/>
      <button className="secondary-button" disabled={busy || !name.trim() || !path.trim()}>{zh ? '添加项目' : 'Add project'}</button></form>
  </SettingsCard>;
}
