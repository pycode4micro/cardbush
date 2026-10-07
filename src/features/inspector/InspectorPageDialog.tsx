import { dialogEventHandler } from '../../shared/dialogEvents';
import { useEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { bookmarkUrl } from './browserBookmarks';
import { normalizeInspectorBrowserAddress } from './inspectorTargets';

export function InspectorPageDialog({ language, onClose, onOpen }: { language: AppLanguage; onClose: () => void; onOpen: (url: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null), [address, setAddress] = useState(''), [error, setError] = useState('');
  const zh = language === 'zh';
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="inspector-page-dialog" onCancel={dialogEventHandler(onClose)} aria-label={zh ? '添加页面' : 'Add page'}>
    <form onSubmit={event => { event.preventDefault(); const url = bookmarkUrl(normalizeInspectorBrowserAddress(address));
      if (!url) { setError(zh ? '请输入有效的 HTTP 或 HTTPS 地址' : 'Enter a valid HTTP or HTTPS address'); return; } onOpen(url); onClose(); }}>
      <h2>{zh ? '添加页面' : 'Add page'}</h2>
      <label>{zh ? '网址' : 'Address'}<input autoFocus value={address} onChange={event => setAddress(event.target.value)} placeholder="https://" /></label>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="submit">{zh ? '打开' : 'Open'}</button></footer>
    </form>
  </dialog>;
}
