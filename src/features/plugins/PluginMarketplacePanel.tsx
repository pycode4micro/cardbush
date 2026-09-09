import { PluginMarketCard } from './PluginMarketCard';
import { ArrowLeft, Check, Download, FolderOpen, LoaderCircle, Plus, RefreshCw, Search, Settings, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginMarketCatalog, PluginMarketPreview, PluginMarketSource } from '../../../electron/pluginMarketplaceTypes';
import type { AppLanguage } from '../../types';

export function PluginMarketplacePanel({ language, onBack, onOpenBundled, onInstalled, onNotify, onOpenNetwork }: {
  language: AppLanguage;
  onBack: () => void;
  onOpenBundled: (id: string) => void;
  onInstalled: (id: string) => Promise<void>;
  onNotify: (message: string) => void;
  onOpenNetwork?: () => void;
}) {
  const zh = language === 'zh';
  const bridge = window.cardbushDesktop;
  const [sources, setSources] = useState<PluginMarketSource[]>([]);
  const [sourceId, setSourceId] = useState('builtin');
  const [catalog, setCatalog] = useState<PluginMarketCatalog | null>(null);
  const [preview, setPreview] = useState<PluginMarketPreview | null>(null);
  const [query, setQuery] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [busy, setBusy] = useState('catalog');
  const [error, setError] = useState('');
  const [installedId, setInstalledId] = useState('');
  const [activated, setActivated] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const generation = useRef(0);
  const selectedSource = sources.find(source => source.id === sourceId);

  useEffect(() => {
    let active = true;
    if (!bridge?.pluginMarketSources) {
      setError(zh ? '请重启 CardBush 以启用插件市场。' : 'Restart CardBush to enable plugin marketplaces.'); setBusy(''); return;
    }
    void bridge.pluginMarketSources().then(value => { if (active) setSources(value); })
      .catch(caught => { if (active) setError(message(caught)); });
    return () => { active = false; generation.current++; };
  }, [bridge, zh]);

  const loadCatalog = useCallback(async (refresh = false) => {
    if (!bridge?.pluginMarketCatalog) return;
    const revision = ++generation.current;
    setBusy('catalog'); setError(''); setPreview(null); if (!refresh) setCatalog(null);
    try {
      const value = await bridge.pluginMarketCatalog(sourceId, refresh);
      if (revision === generation.current) setCatalog(value);
    } catch (caught) { if (revision === generation.current) setError(message(caught)); }
    finally { if (revision === generation.current) setBusy(''); }
  }, [bridge, sourceId]);
  useEffect(() => { void loadCatalog(); return () => { generation.current++; }; }, [loadCatalog]);

  const addSource = async (local = false) => {
    if (!bridge || busy) return;
    setBusy('source'); setError('');
    try {
      const source = local ? await bridge.addLocalPluginMarket() : await bridge.addPluginMarket(sourceInput);
      if (!source) return;
      setSources(await bridge.pluginMarketSources()); setSourceInput(''); setAddOpen(false);
      if (source.id === sourceId) await loadCatalog(true); else setSourceId(source.id);
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(value => value === 'source' ? '' : value); }
  };
  const removeSource = async () => {
    if (!bridge || !selectedSource || selectedSource.builtin || busy) return;
    setBusy('source'); setError('');
    try {
      await bridge.removePluginMarket(sourceId);
      setSources(await bridge.pluginMarketSources()); setSourceId('builtin');
      onNotify(zh ? '市场来源已移除，已安装插件仍保留。' : 'Source removed. Installed plugins are retained.');
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(value => value === 'source' ? '' : value); }
  };
  const openPlugin = async (name: string) => {
    if (catalog?.source.builtin) { onOpenBundled(name); return; }
    if (!bridge || busy) return;
    const revision = ++generation.current;
    setBusy(`preview:${name}`); setError(''); setPreview(null); setInstalledId(''); setActivated(false);
    try {
      const detail = await bridge.previewMarketPlugin(sourceId, name);
      if (revision === generation.current) setPreview(detail);
    } catch (caught) { if (revision === generation.current) setError(message(caught)); }
    finally { if (revision === generation.current) setBusy(''); }
  };
  const install = async () => {
    if (!bridge || !preview || busy || preview.issues.length) return;
    setBusy('install'); setError('');
    let id = installedId;
    try {
      if (!id) {
        const result = await bridge.installMarketPlugin(preview.token);
        id = result.id; setInstalledId(id);
      }
      await onInstalled(id); setActivated(true);
      if (preview.authentication === 'ON_INSTALL') onOpenBundled(id);
      onNotify(zh ? '插件已安装，可在已添加列表查看状态。' : 'Plugin installed. Check its status in Added.');
    } catch (caught) {
      setError(`${id ? (zh ? '插件文件已安装，启用未完成：' : 'Plugin files installed; activation incomplete: ') : ''}${message(caught)}`);
    } finally { setBusy(''); }
  };
  const entries = catalog?.entries.filter(entry => [entry.name, entry.description, entry.category].join(' ').toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <div className="plugin-market-page plugin-catalog-page">
    <button className="plugin-back" type="button" disabled={busy === 'install'} onClick={() => {
      generation.current++;
      if (preview) { setPreview(null); setBusy(''); setError(''); } else onBack();
    }}><ArrowLeft size={17} />{preview ? (zh ? '返回市场' : 'Back to marketplace') : (zh ? '返回插件' : 'Back to plugins')}</button>
    <header className="plugin-market-heading"><div><h2>{preview ? preview.name : (zh ? '插件市场' : 'Plugin marketplaces')}</h2>
      <p>{preview ? preview.description : (zh ? '从自定义市场安装插件，为任务添加技能、工具和自动化。' : 'Install skills, tools and automations from custom plugin marketplaces.')}</p></div>
      {!preview && <button className="plugin-install-button" type="button" disabled={Boolean(busy)} onClick={() => setAddOpen(value => !value)} aria-expanded={addOpen}><Plus size={16} />{zh ? '添加来源' : 'Add source'}</button>}</header>
    {error && <div className="plugin-market-error" role="alert"><p>{marketError(error, zh)}</p>
      {networkError(error) && onOpenNetwork && <button className="plugin-back" type="button" onClick={onOpenNetwork}><Settings size={15} />{zh ? '代理设置' : 'Proxy settings'}</button>}
      <details><summary>{zh ? '错误详情' : 'Error details'}</summary><code>{error}</code></details></div>}
    {preview ? <div className="plugin-market-detail">
      <dl><dt>{zh ? '来源' : 'Source'}</dt><dd>{preview.source}</dd>
        <dt>{zh ? '包格式' : 'Package format'}</dt><dd>{preview.format === 'agent-plugins' ? 'Agent Plugins' : preview.format === 'claude' ? (zh ? 'Claude（兼容模式）' : 'Claude (compatibility mode)') : (zh ? 'Codex 兼容格式' : 'Codex compatibility format')}</dd>
        <dt>{zh ? '版本' : 'Version'}</dt><dd>{preview.version}</dd>
        <dt>{zh ? '开发者' : 'Developer'}</dt><dd>{preview.developerName}</dd>
        <dt>{zh ? '内容版本' : 'Content revision'}</dt><dd>{preview.revision === 'local' ? (zh ? '本地快照' : 'Local snapshot') : preview.revision.slice(0, 12)}</dd></dl>
      <h3>{zh ? '包含的能力' : 'Included capabilities'}</h3>
      {preview.components.map((component, index) => <div className="plugin-component-row" key={`${component.kind}:${index}`}><span className={`plugin-component-kind ${component.kind}`}>{component.kind === 'command' ? '/' : component.kind === 'skill' ? 'S' : component.kind === 'agent' ? 'A' : component.kind === 'hook' ? 'H' : 'M'}</span><div><strong>{component.name}<span className="plugin-market-kind">{component.kind}</span></strong><small>{component.description}</small></div></div>)}
      {!preview.components.length && <p>{zh ? '未发现可加载的能力。' : 'No loadable capabilities found.'}</p>}
      {preview.components.some(component => component.kind === 'command') && <p className="plugin-market-hint">{zh ? 'Commands 原生加载，启用后可在输入框通过 /插件名:命令名 调用。参数和动态上下文由宿主处理，执行遵循当前权限设置。' : 'Commands load natively. Invoke /plugin:command from the composer; the host handles arguments and dynamic context under the current permissions.'}</p>}
      {preview.components.some(component => component.kind === 'hook') && <p className="plugin-market-hint">{zh ? '支持 command、MCP 工具和后台 command Hooks。安装后需在插件详情中审核并信任具体定义，Hooks 才会运行；后台结果会在后续安全位置交给模型。' : 'Command, MCP tool and background command hooks are supported. Review and trust individual definitions in plugin details after installation; background context is delivered at a later safe point.'}</p>}
      {preview.notes?.length ? <div className="plugin-market-notes"><strong>{zh ? '适配说明' : 'Adaptation notes'}</strong><ul>{preview.notes.map((note, index) => <li key={index}>{adaptationNote(note, zh)}</li>)}</ul></div> : null}
      {preview.requirements.length > 0 && <p className="plugin-market-hint">{zh ? '需要本机可运行：' : 'Requires local executables: '}{preview.requirements.join(', ')}</p>}
      {preview.issues.length > 0 ? <div className="plugin-market-issues" role="status"><strong>{zh ? '当前暂不能完整加载' : 'Not fully supported yet'}</strong><ul>{preview.issues.map((issue, index) => <li key={index}>{issueText(issue.code, zh)}{issue.detail && `：${issue.detail}`}</li>)}</ul></div>
        : <p className="plugin-market-hint">{zh ? '结构检查通过。安装后启用插件；MCP 是否连接成功以运行状态为准。' : 'Structure checks passed. Installation enables the plugin; MCP connection health is shown separately.'}</p>}
      <button className="plugin-detail-primary" type="button" disabled={Boolean(busy) || preview.issues.length > 0 || activated} onClick={() => void install()}>
        {busy === 'install' ? <LoaderCircle className="spin" size={16} /> : activated ? <Check size={16} /> : <Download size={16} />}
        {busy === 'install' ? (zh ? '正在安装…' : 'Installing…') : activated ? (zh ? '已安装' : 'Installed') : installedId ? (zh ? '重试启用' : 'Retry activation') : preview.updating ? (zh ? '更新并启用' : 'Update and enable') : (zh ? '安装并启用' : 'Install and enable')}
      </button>
      {activated && <button className="plugin-back" type="button" onClick={() => onOpenBundled(installedId)}>{zh ? '配置连接与权限' : 'Configure connections and approval'}</button>}
    </div> : <>
      {addOpen && <section className="plugin-market-source-form"><div className="plugin-market-source-title"><strong>{zh ? '添加市场来源' : 'Add a marketplace source'}</strong><button className="plugin-back" type="button" disabled={Boolean(busy)} aria-label={zh ? '关闭添加来源' : 'Close add source'} onClick={() => setAddOpen(false)}><X size={16} /></button></div>
        <form className="plugin-market-add" onSubmit={event => { event.preventDefault(); void addSource(); }}>
          <input aria-label={zh ? '市场仓库地址' : 'Marketplace repository'} value={sourceInput} onChange={event => setSourceInput(event.currentTarget.value)} placeholder={zh ? 'Git 仓库地址或 owner/repo' : 'Git repository URL or owner/repo'} disabled={Boolean(busy)} />
          <button className="plugin-install-button" type="submit" disabled={Boolean(busy) || !sourceInput.trim()}>{busy === 'source' && <LoaderCircle className="spin" size={15} />}{busy === 'source' ? (zh ? '正在添加…' : 'Adding…') : (zh ? '添加市场' : 'Add marketplace')}</button>
          <button className="plugin-back" type="button" disabled={Boolean(busy)} onClick={() => void addSource(true)}><FolderOpen size={16} />{zh ? '本地市场' : 'Local marketplace'}</button>
        </form>
        <p className="plugin-market-hint">{zh ? '支持 HTTP(S)、SSH Git 地址和本地目录。用 owner/repo@ref 或地址#ref 指定分支、标签或提交；Git 认证沿用本机配置。' : 'HTTP(S), SSH Git URLs and local directories. Use owner/repo@ref or URL#ref to pin a branch, tag or commit. Git uses your local authentication.'}</p>
      </section>}
      <div className="plugin-market-toolbar"><div className="plugin-market-controls">
        <select aria-label={zh ? '选择插件市场' : 'Select marketplace'} value={sourceId} onChange={event => { setSourceId(event.currentTarget.value); setQuery(''); }} disabled={Boolean(busy)}>
          {sources.map(source => <option key={source.id} value={source.id}>{source.builtin ? (zh ? 'CardBush 精选' : 'CardBush featured') : `${source.location}${source.ref && source.ref !== 'HEAD' ? `@${source.ref}` : ''}`}</option>)}
        </select>
        <button className="plugin-back plugin-market-icon-button" type="button" disabled={Boolean(busy)} title={zh ? '刷新市场' : 'Refresh marketplace'} aria-label={zh ? '刷新市场' : 'Refresh marketplace'} onClick={() => void loadCatalog(true)}><RefreshCw size={16} className={busy === 'catalog' ? 'spin' : undefined} /><span className="sr-only">{zh ? '刷新市场' : 'Refresh marketplace'}</span></button>
        {selectedSource && !selectedSource.builtin && <button className="plugin-back" type="button" title={zh ? '移除来源，保留已安装插件' : 'Remove source; keep installed plugins'} disabled={Boolean(busy)} onClick={() => void removeSource()}><Trash2 size={16} /></button>}
      </div><label className="plugin-search"><Search size={18} /><input aria-label={zh ? '搜索市场插件' : 'Search marketplace plugins'} placeholder={zh ? '搜索插件名称或功能' : 'Search plugins or capabilities'} value={query} onChange={event => setQuery(event.currentTarget.value)} /></label></div>
      {catalog?.cached && <p className="plugin-market-hint" role="status">{zh ? '当前显示缓存目录，刷新未成功：' : 'Showing cached catalog; refresh failed: '}{catalog.error}</p>}
      {busy && busy !== 'source' && <p className="plugin-market-progress" role="status"><LoaderCircle className="spin" size={16} />{busy.startsWith('preview:') ? (zh ? '正在获取插件并检查兼容性…' : 'Downloading plugin and checking compatibility…') : (zh ? '正在读取市场…' : 'Loading marketplace…')}</p>}
      {catalog && <div className="plugin-section-title"><h3>{catalog.source.builtin ? (zh ? 'CardBush 精选' : 'CardBush featured') : catalog.displayName}</h3><span>{zh ? `${entries.length} 个插件` : `${entries.length} plugins`}</span></div>}
      <div className="plugin-market-grid">
        {entries.map(entry => <PluginMarketCard key={`${sourceId}:${catalog?.fetchedAt}:${entry.name}`} entry={entry} sourceId={sourceId} busy={Boolean(busy)} zh={zh} onOpen={() => void openPlugin(entry.name)} />)}
        {catalog && !entries.length && !busy && <p className="plugin-catalog-empty">{zh ? '没有匹配的插件' : 'No matching plugins'}</p>}
      </div>
    </>}
  </div>;
}

function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
function networkError(value: string) { return /ERR_(CONNECTION|NETWORK|PROXY|TUNNEL|NAME)|ECONNRESET|fetch failed|timed? ?out|timeout/i.test(value); }
function marketError(value: string, zh: boolean) {
  if (networkError(value)) return zh ? '暂时无法连接市场。请重试，或检查代理设置；使用代理访问 GitHub 时，需要在 CardBush 中选择对应的代理方式。' : 'Cannot reach the marketplace. Retry or check CardBush proxy settings for GitHub access.';
  return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}
function adaptationNote(note: string, zh: boolean) {
  if (!zh) return note;
  if (note.startsWith('Command ') && note.includes('model inherits')) return `${note.split(':')[0]}：模型沿用当前会话配置。`;
  if (note.includes('declared tool preapprovals')) return `${note.split(':')[0]}：命令声明的工具预授权不能覆盖 CardBush 当前权限设置。`;
  if (note.includes('model inherits')) return `${note.split(':')[0]}：模型沿用 CardBush 的子代理配置，不切换到 Claude 专属模型。`;
  if (note.includes('reasoning effort')) return `${note.split(':')[0]}：思考强度沿用当前会话。`;
  return note;
}
function issueText(code: string, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    components: ['尚未支持的组件', 'Unsupported components'], variables: ['需要配置的环境变量', 'Environment variables require configuration'],
    authentication: ['需要额外认证支持', 'Additional authentication support required'], transport: ['尚未支持的连接方式', 'Unsupported transport'],
    reserved: ['与 CardBush 内置插件重名', 'Name reserved by a bundled plugin'], collision: ['与其他来源的已安装插件重名', 'Installed plugin from another source uses this name'],
    conflicting: ['市场清单与插件定义不一致', 'Marketplace and plugin definitions conflict'],
    empty: ['未发现可加载的能力', 'No loadable capabilities found'], configuration: ['MCP 缺少有效的启动命令或地址', 'MCP requires a valid command or URL'],
    extension: ['此组件的部分功能尚未支持', 'This component uses unsupported features'],
  };
  return labels[code]?.[zh ? 0 : 1] ?? code;
}
