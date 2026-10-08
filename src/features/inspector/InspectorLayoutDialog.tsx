import { useEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { removeInspectorLayout, saveInspectorLayout } from './useSavedInspectorLayouts';
import type { InspectorLayoutSnapshot, SavedInspectorLayout } from './savedInspectorLayouts';

export function InspectorLayoutDialog({ language, snapshot, saved, onClose }: {
  language: AppLanguage; snapshot: InspectorLayoutSnapshot | null; saved?: SavedInspectorLayout; onClose: () => void;
}) {
  const zh = language === 'zh', ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(saved?.name ?? ''), [error, setError] = useState('');
  const content = saved ?? snapshot;
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const fail = (reason: unknown) => {
    const code = reason instanceof Error ? reason.message : '';
    setError(code === 'duplicate-name' ? (zh ? '这个名称已存在，请换一个名称。' : 'This name is already in use.')
      : code === 'layout-limit' ? (zh ? '最多保存 50 个布局，请先删除不再使用的布局。' : 'You can save up to 50 layouts. Remove an unused layout first.')
        : (zh ? '保存失败，请检查本地存储空间后重试。' : 'Could not save. Check local storage and try again.'));
  };
  return <dialog ref={ref} className="inspector-page-dialog inspector-layout-dialog" aria-label={zh ? saved ? '编辑多页面' : '保存多页面' : saved ? 'Edit layout' : 'Save layout'} onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={event => {
      event.preventDefault(); if (!content || !name.trim()) return;
      try { saveInspectorLayout({ ...content, id: saved?.id ?? crypto.randomUUID(), name: name.trim() }); onClose(); } catch (reason) { fail(reason); }
    }}>
      <h2>{zh ? saved ? '编辑多页面' : '保存多页面' : saved ? 'Edit layout' : 'Save layout'}</h2>
      <label>{zh ? '名称' : 'Name'}<input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={zh ? '例如：研究工作台' : 'e.g. Research workspace'}/></label>
      {content ? <>
        <ul className="inspector-layout-pages">{content.pages.map(page => <li key={page.id}>{page.detail.title || page.detail.target}</li>)}</ul>
        <p>{zh ? '保存页面地址和分屏布局，之后可从工具区一键打开。' : 'Save page addresses and pane sizes, then open them from Tools.'}</p>
      </> : <p role="alert">{zh ? '可保存 2–16 个网页或文件页面。请先移出临时任务、Shadow 等会话面板，再保存。' : 'Save 2–16 web or file pages. Remove temporary task or Shadow panels before saving.'}</p>}
      {error && <p role="alert">{error}</p>}
      <footer>{saved && <button type="button" className="inspector-layout-delete" onClick={() => {
        try { removeInspectorLayout(saved.id); onClose(); } catch (reason) { fail(reason); }
      }}>{zh ? '删除' : 'Delete'}</button>}
        <button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" disabled={!content || !name.trim()}>{zh ? '保存' : 'Save'}</button>
      </footer>
    </form>
  </dialog>;
}
