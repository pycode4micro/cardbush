import { uiText } from '../../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { MAX_SEARCH_RESULT_LIMIT, searchResultLimitSchema } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';

export function PluginSearchSettings({ language, value, busy, onSave }: {
  language: AppLanguage;
  value: number;
  busy: boolean;
  onSave: (limit: number) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  const previousValue = useRef(value);
  useEffect(() => {
    const previous = previousValue.current;
    previousValue.current = value;
    setDraft(current => current === String(previous) ? String(value) : current);
  }, [value]);

  return <form className="plugin-search-settings" noValidate onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    const parsed = searchResultLimitSchema.safeParse(draft.trim() ? Number(draft) : NaN);
    if (!parsed.success) {
      setError(uiText(language)('pluginSearchSettings.enterAnIntegerFrom1To', { MAX_SEARCH_RESULT_LIMIT }));
      return;
    }
    setError('');
    try { await onSave(parsed.data); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }}>
    <div className="plugin-search-setting-copy">
      <label htmlFor={id}>{uiText(language)('pluginSearchSettings.defaultSearchResults')}</label>
      <p id={`${id}-help`}>{uiText(language)('pluginSearchSettings.sharedBySkillAndMcpToolSearches', { MAX_SEARCH_RESULT_LIMIT })}</p>
    </div>
    <div className="plugin-search-setting-controls">
      <input id={id} type="number" min={1} max={MAX_SEARCH_RESULT_LIMIT} step={1} value={draft} disabled={busy}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={Boolean(error)}
        onChange={event => { setDraft(event.target.value); setError(''); }}/>
      <button className="plugin-back" type="submit" disabled={busy || draft === String(value)}>
        {uiText(language)('appCenter.save')}
      </button>
    </div>
    {error && <p id={`${id}-error`} className="plugin-market-error" role="alert">{error}</p>}
  </form>;
}
