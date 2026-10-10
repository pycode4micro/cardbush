import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { SolutionSelectionCard } from '../src/features/interactions/SolutionSelectionCard';
import { api, requestId, type User } from './api';
import { seedCachedImage, useAccountCache, useCachedImage } from './BrowserCacheProvider';
import { prepareAttachment, uploadInChunks } from './attachmentUpload';

export type Attachment = { id: string; path: string; name: string; mime: string; size: number; uploadNote?: string };
export function useAttachments() {
  const cache = useAccountCache();
  const [items, setItems] = useState<Attachment[]>([]), [progress, setProgress] = useState(''), [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  const clear = useCallback(() => { current.current?.abort(); current.current = null; setItems([]); setProgress(''); setError(''); }, []);
  useEffect(() => () => current.current?.abort(), []);
  const add = async (files: File[]) => {
    if (current.current || !files.length) return;
    if (files.length + items.length > 8) { setError('每条消息最多 8 个附件。'); return; }
    const controller = new AbortController(); current.current = controller; setError(''); setProgress('准备附件…');
    try {
      const failures: string[] = [];
      for (const original of files) {
        controller.signal.throwIfAborted();
        try {
          const prepared = await prepareAttachment(original, controller.signal, setProgress), file = prepared.file;
          const uploadId = requestId();
          setProgress(`正在上传 ${file.name} · 0%`);
          const attachment = await uploadInChunks<Attachment>(file, controller.signal, chunk => {
            controller.signal.throwIfAborted();
            if (!cache.valid()) throw new Error('账号已切换，请重新登录后上传。');
            return api('/files', 'POST', { uploadId, name: file.name, size: file.size, ...chunk }, controller.signal);
          }, percent => setProgress(`正在上传 ${file.name} · ${percent}%`));
          if (!cache.valid()) throw new Error('账号已切换，请重新登录后上传。');
          // Cache the browser's actual encoded MIME; the server independently normalizes its own copy.
          if (attachment.mime.startsWith('image/')) seedCachedImage(cache, attachment.path, file);
          setItems(previous => [...previous, { ...attachment, uploadNote: prepared.note }]);
        } catch (reason) {
          controller.signal.throwIfAborted();
          failures.push(`${original.name || '附件'}：${reason instanceof Error ? reason.message : '上传失败，请重试。'}`);
          setError(failures.join('\n'));
        }
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '上传失败。'); }
    finally { if (current.current === controller) { current.current = null; setProgress(''); } }
  };
  return { items, busy: Boolean(progress), progress, error, add, clear, cancel: () => current.current?.abort(), dismissError: () => setError(''), remove: (id: string) => setItems(previous => previous.filter(item => item.id !== id)) };
}
export function AttachmentThumbnail({ path }: { path: string }) { const { src } = useCachedImage(path); return src ? <img src={src} alt=""/> : <FileText size={15}/>; }
export function AttachmentDrafts({ upload }: { upload: ReturnType<typeof useAttachments> }) {
  return <>
    {upload.items.length > 0 && <div className="upload-chips">{upload.items.map(item => <span className="file-chip" key={item.id}>
      {item.mime.startsWith('image/') && <AttachmentThumbnail path={item.path}/>}
      <span className="upload-file-name">{item.name}{item.uploadNote && <small>{item.uploadNote}</small>}</span>
      <button type="button" aria-label={`移除${item.name}`} onClick={() => upload.remove(item.id)}><X size={13}/></button>
    </span>)}</div>}
    {upload.progress && <div className="upload-progress" role="status" aria-live="polite"><span>{upload.progress}</span><button type="button" onClick={upload.cancel}>取消上传</button></div>}
    {upload.error && <div className="upload-error"><p className="form-error" role="alert">{upload.error}</p><button className="icon-button" type="button" aria-label="关闭上传提示" onClick={upload.dismissError}><X size={15}/></button></div>}
  </>;
}
export function UploadButton({ upload }: { upload: ReturnType<typeof useAttachments> }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.log,.pdf,.docx,.xlsx,.pptx" onChange={event => { void upload.add(Array.from(event.target.files ?? [])); event.target.value = ''; }}/><button className="icon-button" type="button" aria-label="上传图片或文件" title="大图自动优化，文档单个不超过 16 MB，不支持视频" disabled={upload.busy} onClick={() => input.current?.click()}><Paperclip size={18}/></button></>;
}
export type Solution = { selectionId: string; sessionId: string; turnId: string; prompt: string; options: string[] };
export function Solutions({ items, refresh }: { items: Solution[]; refresh: () => Promise<void> }) {
  return <>{items.map(item => <SolutionSelectionCard key={item.selectionId} language="zh" interaction={{ id: item.selectionId, sessionId: item.sessionId, turnId: item.turnId, raw: item, questions: [{ id: item.selectionId, label: item.prompt, question: item.prompt, options: item.options.map((label,index) => ({ id: String(index), label })) }] }} onReply={async answers => { const answer = answers[0]; await api(`/sessions/${item.sessionId}/solutions`, 'POST', { selectionId: item.selectionId, turnId: item.turnId, ...(answer.selectedOptionId !== undefined ? { kind: 'option', optionIndex: Number(answer.selectedOptionId) } : { kind: 'text', text: answer.text }) }); await refresh(); }} onCancel={async () => { await api(`/sessions/${item.sessionId}/solutions`, 'POST', { selectionId: item.selectionId, turnId: item.turnId, kind: 'cancel' }); await refresh(); }}/>)}</>;
}
type Plugin = { installed: boolean; enabled: boolean; grants: string[] };
export function PluginAdmin({ users }: { users: User[] }) {
  const [plugin, setPlugin] = useState<Plugin | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { void api<Plugin>('/admin/plugins').then(setPlugin).catch(reason => setError(String(reason))); }, []);
  const action = async (path: string, method: string, input: unknown) => { setBusy(true); setError(''); try { setPlugin(await api<Plugin>(path,method,input)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  return <section className="plugin-panel"><h2>插件管理</h2><p className="muted">默认开放个人文件读取、查看图片、方案选择、上下文整理和技能检索。下面的插件需逐个账号授权。</p><div className="plugin-card"><div><strong>火山图片生成</strong><span>Seedream · 原生异步生成与编辑</span><p>只提供图片功能。视频、终端、任意写文件和跨账号访问均未开放。</p></div>{plugin && <div className="plugin-actions"><span className={`user-status ${plugin.installed && plugin.enabled ? 'enabled' : ''}`}>{!plugin.installed ? '未安装' : plugin.enabled ? '已启用' : '已停用'}</span>{!plugin.installed ? <button disabled={busy} onClick={() => void action('/admin/plugins','POST',{action:'install'})}>安装图片插件</button> : <><button disabled={busy} onClick={() => void action('/admin/plugins','POST',{action:plugin.enabled?'disable':'enable'})}>{plugin.enabled?'停用':'启用'}</button><button disabled={busy} onClick={() => void action('/admin/plugins','POST',{action:'uninstall'})}>卸载</button></>}</div>}</div>{error && <p className="form-error" role="alert">{error}</p>}{plugin?.installed && <div className="plugin-grants"><h3>账号授权</h3><p className="muted">授权在下次对话时加载；撤销后立即禁止新的图片生成，已提交任务继续完成。</p>{users.map(user => <label key={user.id}><span>{user.display_name}<small>{user.username}</small></span><input type="checkbox" aria-label={`${user.username}的图片插件权限`} checked={plugin.grants.includes(user.id)} disabled={busy} onChange={event => void action(`/admin/plugins/volcengine_images/users/${user.id}`,'PUT',{enabled:event.target.checked})}/></label>)}</div>}</section>;
}
