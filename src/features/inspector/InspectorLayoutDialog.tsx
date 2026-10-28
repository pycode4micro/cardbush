import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { removeInspectorLayout, saveInspectorLayout } from './useSavedInspectorLayouts';
import type { InspectorLayoutSnapshot, SavedInspectorLayout } from './savedInspectorLayouts';

export function InspectorLayoutDialog({ language, snapshot, saved, onClose }: {
  language: AppLanguage; snapshot: InspectorLayoutSnapshot | null; saved?: SavedInspectorLayout; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(saved?.name ?? ''), [error, setError] = useState('');
  const content = saved ?? snapshot;
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const fail = (reason: unknown) => {
    const code = reason instanceof Error ? reason.message : '';
    setError(code === 'duplicate-name' ? (uiText(language)('inspectorLayoutDialog.thisNameIsAlreadyInUse'))
      : code === 'layout-limit' ? (uiText(language)('inspectorLayoutDialog.youCanSaveUpTo50Layouts'))
        : (uiText(language)('inspectorLayoutDialog.couldNotSaveCheckLocalStorageAnd')));
  };
  return <dialog ref={ref} className="inspector-page-dialog inspector-layout-dialog" aria-label={(saved ? uiText(language)('inspectorLayoutDialog.editLayout') : uiText(language)('inspectorActions.saveLayout'))} onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={event => {
      event.preventDefault(); if (!content || !name.trim()) return;
      try { saveInspectorLayout({ ...content, id: saved?.id ?? crypto.randomUUID(), name: name.trim() }); onClose(); } catch (reason) { fail(reason); }
    }}>
      <h2>{(saved ? uiText(language)('inspectorLayoutDialog.editLayout') : uiText(language)('inspectorActions.saveLayout'))}</h2>
      <label>{uiText(language)('agentConnectionForm.name')}<input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={uiText(language)('inspectorLayoutDialog.eGResearchWorkspace')}/></label>
      {content ? <>
        <ul className="inspector-layout-pages">{content.pages.map(page => <li key={page.id}>{page.detail.title || page.detail.target}</li>)}</ul>
        <p>{uiText(language)('inspectorLayoutDialog.savePageAddressesAndPaneSizesThen')}</p>
      </> : <p role="alert">{uiText(language)('inspectorLayoutDialog.save216WebOrFilePages')}</p>}
      {error && <p role="alert">{error}</p>}
      <footer>{saved && <button type="button" className="inspector-layout-delete" onClick={() => {
        try { removeInspectorLayout(saved.id); onClose(); } catch (reason) { fail(reason); }
      }}>{uiText(language)('appCenter.delete')}</button>}
        <button type="button" onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button>
        <button type="submit" disabled={!content || !name.trim()}>{uiText(language)('appCenter.save')}</button>
      </footer>
    </form>
  </dialog>;
}
