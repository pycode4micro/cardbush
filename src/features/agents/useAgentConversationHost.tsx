import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardbushAppPlugin, PluginCommandSummary, SkillSummary } from '../../types';
import { runtimeHistoryToolExecution } from '../../backend/api';
import type { ConversationHost } from '../conversationHost';
import { agentRuntimeClient, type AgentCall } from './AgentConversationUi';

const chunkSize = 512 * 1024;
const maxSize = 64 * 1024 * 1024;
type Catalog = { skills: SkillSummary[]; pluginCommands: PluginCommandSummary[] };
export function useAgentConversationHost(call: AgentCall, connectionId: string, sessionId: string, enabled: boolean, management = false) {
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], pluginCommands: [] });
  const [plugins, setPlugins] = useState<CardbushAppPlugin[]>([]);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ name: string; url: string; text?: string; image: boolean }>();
  const client = useMemo(() => agentRuntimeClient(call), [call]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.all([call<Catalog>('conversation.catalog'), call<{ plugins: CardbushAppPlugin[] }>('product.command', { kind: 'apps.get' })])
      .then(([catalog, config]) => { if (alive) { setCatalog({ ...catalog, skills: catalog.skills.map(skill => ({ ...skill, logoPath: '', logoDarkPath: '' })) }); setPlugins(config.plugins.map(plugin => ({ ...plugin, logoPath: '', logoDarkPath: '' }))); } })
      .catch(error => { if (alive) setError(String(error.message ?? error)); });
    return () => { alive = false; };
  }, [call, enabled]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
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
      const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' } as Record<string, string>)[ext];
      const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
      return { name, blob };
  }, [call, sessionId, enabled]);
  const openFile = useCallback((path: string) => {
    void (async () => {
      const { name, blob } = await readFile(path);
      const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
      const mime = blob.type.startsWith('image/');
      const text = !mime && /^(txt|md|json|csv|log|ts|tsx|js|jsx|py|yaml|yml|toml|css|html|xml|sh)$/.test(ext) && blob.size < 2 * 1024 * 1024 ? await blob.text() : undefined;
      setPreview({ name, url: URL.createObjectURL(blob), image: Boolean(mime), text });
    })().catch(error => setError(String(error.message ?? error)));
  }, [readFile]);
  const host = useMemo<ConversationHost>(() => ({ id: `${connectionId}:${sessionId}`, plugins, pluginCommands: catalog.pluginCommands, uploadFiles, openFile,
    readFile, readDirectory: management ? input => call('files.list', { ...input, sessionId }) : undefined,
    toolDetails: async (sessionId, turnId) => (await client.listTurnToolExecutions({ sessionId, turnId })).map(runtimeHistoryToolExecution),
  }), [connectionId, sessionId, plugins, catalog.pluginCommands, uploadFiles, openFile, readFile, client, call, management]);
  return { host, skills: catalog.skills, error, preview, closePreview: () => setPreview(undefined) };
}
