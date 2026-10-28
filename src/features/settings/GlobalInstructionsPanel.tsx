import { uiText } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { readGlobalInstructions, saveGlobalInstructions, type GlobalInstructionsSnapshot } from '../../backend/globalInstructions';
import type { AppLanguage } from '../../types';

export type InstructionsSource = { read: typeof readGlobalInstructions; save: typeof saveGlobalInstructions };
const localSource: InstructionsSource = { read: readGlobalInstructions, save: saveGlobalInstructions };
export function GlobalInstructionsPanel({ language, source = localSource }: { language: AppLanguage; source?: InstructionsSource }) {

  const [snapshot, setSnapshot] = useState<GlobalInstructionsSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    source.read().then(value => {
      if (active) { setSnapshot(value); setDraft(value.content); }
    }).catch(caught => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [source]);

  const reload = useCallback(async () => {
    if (snapshot && draft !== snapshot.content && !window.confirm(uiText(language)('globalInstructionsPanel.reloadingWillReplaceYourUnsavedEditsContinue'))) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const value = await source.read();
      setSnapshot(value); setDraft(value.content);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }, [draft, snapshot, language, source]);

  const save = async () => {
    if (!snapshot || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const value = await source.save(draft, snapshot.revision);
      setSnapshot(value); setDraft(value.content); setSaved(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <section className="settings-card global-instructions-card">
    <div className="settings-card-header">
      <div className="settings-card-heading">
        <h3 id="global-instructions-title">{uiText(language)('globalInstructionsPanel.globalInstructions')}</h3>
        <p>{uiText(language)('globalInstructionsPanel.sharedPreferencesForConversationsAndSubtasksSaved')}</p>
      </div>
    </div>
    <div className="settings-card-body">
      <textarea
        id="global-agent-instructions"
        aria-labelledby="global-instructions-title"
        className="global-instructions-editor"
        value={draft}
        disabled={busy || !snapshot}
        spellCheck={false}
        onChange={event => { setDraft(event.currentTarget.value); setSaved(false); }}
        placeholder={uiText(language)('globalInstructionsPanel.forExamplePreferredLanguageWorkingStyleAnd')}
      />
      <details className="global-instructions-file-details">
        <summary>{uiText(language)('globalInstructionsPanel.fileLocationProjectRules')}</summary>
        <p className="global-instructions-hint">{uiText(language)('globalInstructionsPanel.maintainProjectAndDirectoryRulesInTheir')}</p>
        {snapshot && <code className="global-instructions-path" title={snapshot.path}>{snapshot.path}</code>}
      </details>
      <div className="global-instructions-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />{uiText(language)('globalInstructionsPanel.reloadFile')}</button>
        <button className="primary-button" type="button" disabled={busy || !snapshot || draft === snapshot.content} onClick={() => void save()}>
          {busy ? <LoaderCircle size={14} /> : <Check size={14} />}{uiText(language)('appCenter.save')}
        </button>
      </div>
      {error && <p className="global-instructions-error" role="alert">{error}</p>}
      {saved && <p className="global-instructions-hint" role="status">{uiText(language)('globalInstructionsPanel.savedToAgentsMd')}</p>}
    </div>
  </section>;
}
