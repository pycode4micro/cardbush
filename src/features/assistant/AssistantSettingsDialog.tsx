import { useEffect, useRef, useState } from 'react';
import { Camera, Lightbulb, RotateCcw, X } from 'lucide-react';
import { readAssistantProfile, saveAssistantProfile } from './assistantProfile';
import { prepareAssistantAvatar, readAssistantAvatar, saveAssistantAvatar } from './assistantAvatar';

export function AssistantSettingsDialog({ language, onClose }: { language: 'zh' | 'en'; onClose(): void }) {
  const zh = language === 'zh', dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => readAssistantProfile().name), [persona, setPersona] = useState(() => readAssistantProfile().persona);
  const [avatar, setAvatar] = useState(readAssistantAvatar), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current; node?.showModal(); nameInput.current?.focus({ preventScroll: true });
    return () => { request.current++; node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    const id = ++request.current; setLoading(true); setError('');
    try { const next = await prepareAssistantAvatar(file, language); if (id === request.current) setAvatar(next); }
    catch (error) { if (id === request.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === request.current) setLoading(false); }
  };
  const save = () => {
    if (loading) return;
    if (!name.trim()) { setError(zh ? '请输入名称。' : 'Enter a name.'); nameInput.current?.focus(); return; }
    const previousAvatar = readAssistantAvatar();
    try {
      saveAssistantAvatar(avatar);
      try { saveAssistantProfile({ ...readAssistantProfile(), name: name.trim(), persona }); }
      catch (error) { saveAssistantAvatar(previousAvatar); throw error; }
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <dialog ref={dialog} className="assistant-settings-dialog" aria-labelledby="assistant-settings-title" onCancel={event => {
    // File pickers also emit a bubbling cancel event; only Escape on this dialog
    // should dismiss the settings and discard its draft.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onClose();
  }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <header><div><h2 id="assistant-settings-title">{zh ? '助手设置' : 'Assistant settings'}</h2><p>{zh ? '让它更像你熟悉的伙伴' : 'Make it feel like your companion'}</p></div>
        <button type="button" className="assistant-settings-close" aria-label={zh ? '关闭设置' : 'Close settings'} onClick={onClose}><X size={18}/></button></header>
      <div className="assistant-avatar-picker">
        <button type="button" className="assistant-avatar-preview" aria-label={zh ? '更换头像' : 'Change avatar'} disabled={loading} onClick={() => fileInput.current?.click()}>
          {avatar ? <img src={avatar} alt=""/> : <Lightbulb size={34} strokeWidth={1.5}/>}
          <span><Camera size={13}/></span>
        </button>
        <div><button type="button" disabled={loading} onClick={() => fileInput.current?.click()}>{loading ? zh ? '正在处理…' : 'Preparing…' : zh ? '选择图片' : 'Choose image'}</button>
          {avatar && <button type="button" className="assistant-avatar-reset" disabled={loading} onClick={() => { setAvatar(''); setError(''); }}><RotateCcw size={13}/>{zh ? '恢复灯泡' : 'Restore lightbulb'}</button>}
          <small>{zh ? 'PNG / JPG / WebP · 最大 8 MB · 仅保存在本机' : 'PNG / JPG / WebP · Up to 8 MB · Stored on this device'}</small></div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void choose(file); }}/>
      </div>
      <label>{zh ? '名称' : 'Name'}<input ref={nameInput} name="assistant-name" value={name} maxLength={60} onChange={event => { setName(event.target.value); setError(''); }}/></label>
      <label>{zh ? '角色与交流方式' : 'Persona and conversation style'}<textarea name="assistant-persona" value={persona} maxLength={2000} rows={5} onChange={event => setPersona(event.target.value)}/></label>
      <p className="assistant-settings-note">{zh ? '角色修改将在下一次通话时生效。' : 'Persona changes apply to the next call.'}</p>
      {error && <p className="assistant-settings-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="submit" disabled={loading}>{zh ? '保存' : 'Save'}</button></footer>
    </form>
  </dialog>;
}
