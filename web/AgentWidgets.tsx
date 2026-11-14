import { uiText } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { SolutionSelectionCard } from '../src/features/interactions/SolutionSelectionCard';
import { solutionInteractionAnswer, solutionInteractionQuestions } from '../src/features/interactions/solutionSelectionModel';
import type { RuntimeSolutionSelection } from '@cardbush/bush-protocol';
import { api, requestId, type User } from './api';
import { seedCachedImage, useAccountCache, useCachedImage } from './BrowserCacheProvider';
import { prepareAttachment, uploadInChunks } from './attachmentUpload';

export type Attachment = { id: string; path: string; name: string; mime: string; size: number; uploadNote?: string };
export function useAttachments() {
  const language = useUiLanguage();

  const cache = useAccountCache();
  const [items, setItems] = useState<Attachment[]>([]), [progress, setProgress] = useState(''), [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  const clear = useCallback(() => { current.current?.abort(); current.current = null; setItems([]); setProgress(''); setError(''); }, []);
  useEffect(() => () => current.current?.abort(), []);
  const add = async (files: File[]) => {
    if (current.current || !files.length) return;
    if (files.length + items.length > 8) { setError(uiText(language)("web.eachMessageSupportsUpTo8Attachments")); return; }
    const controller = new AbortController(); current.current = controller; setError(''); setProgress(uiText(language)("web.preparingAttachments"));
    try {
      const failures: string[] = [];
      for (const original of files) {
        controller.signal.throwIfAborted();
        try {
          const prepared = await prepareAttachment(original, controller.signal, setProgress), file = prepared.file;
          const uploadId = requestId();
          setProgress(uiText(language)("web.uploading0", { name: file.name }));
          const attachment = await uploadInChunks<Attachment>(file, controller.signal, chunk => {
            controller.signal.throwIfAborted();
            if (!cache.valid()) throw new Error(uiText(language)("web.theAccountChangedSignInAgainBeforeUploading"));
            return api('/files', 'POST', { uploadId, name: file.name, size: file.size, ...chunk }, controller.signal);
          }, percent => setProgress(uiText(language)("web.uploading", { name: file.name, percent })));
          if (!cache.valid()) throw new Error(uiText(language)("web.theAccountChangedSignInAgainBeforeUploading"));
          // Cache the browser's actual encoded MIME; the server independently normalizes its own copy.
          if (attachment.mime.startsWith('image/')) seedCachedImage(cache, attachment.path, file);
          setItems(previous => [...previous, { ...attachment, uploadNote: prepared.note }]);
        } catch (reason) {
          controller.signal.throwIfAborted();
          failures.push(`${original.name || uiText(language)("image.scope.attachments")}：${reason instanceof Error ? reason.message : uiText(language)("web.uploadFailedPleaseTryAgain")}`);
          setError(failures.join('\n'));
        }
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : uiText(language)("web.uploadFailed")); }
    finally { if (current.current === controller) { current.current = null; setProgress(''); } }
  };
  return { items, busy: Boolean(progress), progress, error, add, clear, cancel: () => current.current?.abort(), dismissError: () => setError(''), remove: (id: string) => setItems(previous => previous.filter(item => item.id !== id)) };
}
export function AttachmentThumbnail({ path }: { path: string }) { const { src } = useCachedImage(path); return src ? <img src={src} alt=""/> : <FileText size={15}/>; }
export function AttachmentDrafts({ upload }: { upload: ReturnType<typeof useAttachments> }) {
  const language = useUiLanguage();

  return <>
    {upload.items.length > 0 && <div className="upload-chips">{upload.items.map(item => <span className="file-chip" key={item.id}>
      {item.mime.startsWith('image/') && <AttachmentThumbnail path={item.path}/>}
      <span className="upload-file-name">{item.name}{item.uploadNote && <small>{item.uploadNote}</small>}</span>
      <button type="button" aria-label={uiText(language)("web.remove", { name: item.name })} onClick={() => upload.remove(item.id)}><X size={13}/></button>
    </span>)}</div>}
    {upload.progress && <div className="upload-progress" role="status" aria-live="polite"><span>{upload.progress}</span><button type="button" onClick={upload.cancel}>{uiText(language)("web.cancelUpload")}</button></div>}
    {upload.error && <div className="upload-error"><p className="form-error" role="alert">{upload.error}</p><button className="icon-button" type="button" aria-label={uiText(language)("web.dismissUploadNotice")} onClick={upload.dismissError}><X size={15}/></button></div>}
  </>;
}
export function UploadButton({ upload }: { upload: ReturnType<typeof useAttachments> }) {
  const language = useUiLanguage();

  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.log,.pdf,.docx,.xlsx,.pptx,.mp4,.m4v,.mov,.webm,.mp3,.wav,.ogg,.m4a" onChange={event => { void upload.add(Array.from(event.target.files ?? [])); event.target.value = ''; }}/><button className="icon-button" type="button" aria-label={uiText(language)("web.uploadImagesOrFiles")} title={uiText(language)("web.largeImagesAreOptimizedAutomaticallyDocumentsMustBeUnder16MbVideo")} disabled={upload.busy} onClick={() => input.current?.click()}><Paperclip size={18}/></button></>;
}
export type Solution = RuntimeSolutionSelection;
export function Solutions({ items, refresh }: { items: Solution[]; refresh: () => Promise<void> }) {
  const language = useUiLanguage();

  return <>{items.map(item => {
    const interaction = { id: item.selectionId, sessionId: item.sessionId, turnId: item.turnId,
      raw: item, questions: solutionInteractionQuestions(item) };
    return <SolutionSelectionCard key={JSON.stringify([item.sessionId, item.selectionId])} language={language} interaction={interaction}
      onReply={async answers => {
        const { sessionId: _, ...answer } = solutionInteractionAnswer(interaction, answers);
        await api(`/sessions/${item.sessionId}/solutions`, 'POST', answer); await refresh();
      }} onCancel={async () => {
        await api(`/sessions/${item.sessionId}/solutions`, 'POST', { selectionId: item.selectionId, turnId: item.turnId, kind: 'cancel' }); await refresh();
      }}/>;
  })}</>;
}
type Plugin = { installed: boolean; enabled: boolean; grants: string[] };
export function PluginAdmin({ users }: { users: User[] }) {
  const language = useUiLanguage();

  const [plugin, setPlugin] = useState<Plugin | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { void api<Plugin>('/admin/plugins').then(setPlugin).catch(reason => setError(String(reason))); }, []);
  const action = async (path: string, method: string, input: unknown) => { setBusy(true); setError(''); try { setPlugin(await api<Plugin>(path,method,input)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  return <section className="plugin-panel"><h2>{uiText(language)("web.pluginManagement")}</h2><p className="muted">{uiText(language)("web.personalFileReadingImageViewingQuestionsContextCompactionAndSkillSearchAre")}</p><div className="plugin-card"><div><strong>{uiText(language)("web.volcengineImageGeneration")}</strong><span>{uiText(language)("web.seedreamImageGenerationConversionAndStitching")}</span><p>{uiText(language)("web.setImageDimensionsConvertPngJpgWebpOrCombineUpTo64")}</p></div>{plugin && <div className="plugin-actions"><span className={`user-status ${plugin.installed && plugin.enabled ? 'enabled' : ''}`}>{!plugin.installed ? uiText(language)("sandboxSettingsPanel.notInstalled") : plugin.enabled ? uiText(language)("automationPanel.active") : uiText(language)("pluginManagementPanel.disabled")}</span>{!plugin.installed ? <button disabled={busy} onClick={() => void action('/admin/plugins','POST',{action:'install'})}>{uiText(language)("web.installImagePlugin")}</button> : <><button disabled={busy} onClick={() => void action('/admin/plugins','POST',{action:plugin.enabled?'disable':'enable'})}>{plugin.enabled?uiText(language)("pluginMcpSettings.disable"):uiText(language)("automationPanel.enable")}</button><button disabled={busy} onClick={() => void action('/admin/plugins','POST',{action:'uninstall'})}>{uiText(language)("settingsView.uninstall")}</button></>}</div>}</div>{error && <p className="form-error" role="alert">{error}</p>}{plugin?.installed && <div className="plugin-grants"><h3>{uiText(language)("web.accountAccess")}</h3><p className="muted">{uiText(language)("web.accessLoadsWithTheNextConversationRevokingItImmediatelyBlocksNewImage")}</p>{users.map(user => <label key={user.id}><span>{user.display_name}<small>{user.username}</small></span><input type="checkbox" aria-label={uiText(language)("web.imagePluginAccessFor", { username: user.username })} checked={plugin.grants.includes(user.id)} disabled={busy} onChange={event => void action(`/admin/plugins/volcengine_images/users/${user.id}`,'PUT',{enabled:event.target.checked})}/></label>)}</div>}</section>;
}
