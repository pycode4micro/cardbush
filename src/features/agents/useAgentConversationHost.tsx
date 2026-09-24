import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardbushAppPlugin, PluginCommandSummary, SkillSummary } from '../../types';
import { runtimeHistoryToolExecution } from '../../backend/api';
import type { ConversationHost } from '../conversationHost';
import { agentRuntimeClient, type AgentCall } from './agentConversationBackend';
import { conversationViewKey, useConversationViewState } from '../../shared/conversationViewState';

const chunkSize = 512 * 1024;
const maxSize = 64 * 1024 * 1024;
type Catalog = { skills: SkillSummary[]; pluginCommands: PluginCommandSummary[] };
export function useAgentConversationHost(call: AgentCall, connectionId: string, sessionId: string, enabled: boolean, management = false) {
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], pluginCommands: [] });
  const [plugins, setPlugins] = useState<CardbushAppPlugin[]>([]);
  const [error, setError] = useState('');
  const [preview, setPreview] = useConversationViewState<{ path: string; name: string } | undefined>(
    conversationViewKey(connectionId, sessionId, 'preview'), () => undefined);
  const client = useMemo(() => agentRuntimeClient(call), [call]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void Promise.all([call<Catalog>('conversation.catalog'), call<{ plugins: CardbushAppPlugin[] }>('product.command', { kind: 'apps.get' })])
        .then(([catalog, config]) => { if (alive && current === revision) { setError(''); setCatalog({ ...catalog, skills: catalog.skills.map(skill => ({ ...skill, logoPath: '', logoDarkPath: '' })) }); setPlugins(config.plugins.map(plugin => ({ ...plugin, logoPath: '', logoDarkPath: '' }))); } })
        .catch(error => { if (alive && current === revision) setError(String(error.message ?? error)); });
    };
    const restored = (event: Event) => { if ((event as CustomEvent<string>).detail === connectionId) refresh(); };
    refresh();
    window.addEventListener('cardbush:agent-connection-restored', restored);
    return () => { alive = false; window.removeEventListener('cardbush:agent-connection-restored', restored); };
  }, [call, connectionId, enabled]);
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!enabled) throw new Error('请更新此 Agent 服务以支持附件。Update this Agent service to transfer files.');
    if (files.length > 32) throw new Error('一次最多上传 32 个文件 / Upload up to 32 files at a time');
    for (const file of files) if (file.size > maxSize) throw new Error('附件不能超过 64 MiB / Maximum attachment size: 64 MiB');
    const result: Array<{ path: string; name: string }> = [];
    for (const file of files) {
      const uploadId = crypto.randomUUID(); let offset = 0;
      do {
        const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
        let raw = ''; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const next = await call<{ path: string; name: string; nextOffset: number }>('files.upload', { sessionId, uploadId, name: file.name, offset, content: btoa(raw) });
        if (next.nextOffset !== offset + bytes.length) throw new Error('Invalid upload acknowledgement.');
        offset = next.nextOffset;
        if (offset === file.size) result.push({ path: next.path, name: next.name });
      } while (offset < file.size);
    }
    return result;
  }, [call, sessionId, enabled]);
  const readFile = useCallback(async (path: string) => {
      if (!enabled) throw new Error('Update this Agent service to preview files.');
      if (path.startsWith('cardbush-extract://')) {
        const id = path.slice('cardbush-extract://'.length).replace(/\.md$/, '');
        const result = await call<{ name: string; content: string }>('conversation.extracts', { action: 'read', id });
        return { name: result.name, blob: new Blob([result.content], { type: 'text/markdown' }) };
      }
      const parts: Uint8Array<ArrayBuffer>[] = []; let offset = 0; let name = '';
      while (true) {
        const part = await call<{ content: string; name: string; size: number; offset: number; done: boolean }>('files.read', { sessionId, path, offset });
        if (part.size > maxSize || part.offset !== offset) throw new Error('Invalid file response.');
        const bytes = Uint8Array.from(atob(part.content), char => char.charCodeAt(0));
        parts.push(bytes); offset += bytes.length; name = part.name;
        if (offset > maxSize || (!part.done && !bytes.length)) throw new Error('Invalid file response.');
        if (part.done) break;
      }
      const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
      const mime = ({ svg: 'image/svg+xml', pdf: 'application/pdf', html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' } as Record<string, string>)[ext];
      const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
      return { name, blob };
  }, [call, sessionId, enabled]);
  const openFile = useCallback((path: string) => { setPreview({ path, name: path.replaceAll('\\', '/').split('/').at(-1) || path }); }, [setPreview]);
  const previewFile = useCallback(async (path: string) => {
    const api = window.cardbushDesktop?.agents;
    if (!enabled || !api?.filePreview) throw new Error('请重启更新后的 CardBush，并连接支持文件读取的 Agent。');
    const preview = await api.filePreview(connectionId, sessionId, path);
    return { source: preview.url, dispose: () => { void api.releaseFilePreview(preview.id).catch(() => {}); } };
  }, [connectionId, sessionId, enabled]);
  const host = useMemo<ConversationHost>(() => ({ id: `${connectionId}:${sessionId}`, plugins, pluginCommands: catalog.pluginCommands, uploadFiles, openFile,
    openExtract: id => openFile(`cardbush-extract://${id}.md`),
    readFile, previewFile, readDirectory: management ? input => call('files.list', { ...input, sessionId }) : undefined,
    toolDetails: async (sessionId, turnId) => (await client.listTurnToolExecutions({ sessionId, turnId })).map(runtimeHistoryToolExecution),
  }), [connectionId, sessionId, plugins, catalog.pluginCommands, uploadFiles, openFile, readFile, previewFile, client, call, management]);
  const closePreview = useCallback(() => setPreview(undefined), [setPreview]);
  return { host, skills: catalog.skills, error, preview, closePreview };
}
