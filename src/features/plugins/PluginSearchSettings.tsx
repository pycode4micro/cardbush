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
  const zh = language === 'zh';
  return <form className="plugin-search-settings" noValidate onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    const parsed = searchResultLimitSchema.safeParse(draft.trim() ? Number(draft) : NaN);
    if (!parsed.success) {
      setError(zh ? `请输入 1–${MAX_SEARCH_RESULT_LIMIT} 之间的整数。` : `Enter an integer from 1 to ${MAX_SEARCH_RESULT_LIMIT}.`);
      return;
    }
    setError('');
    try { await onSave(parsed.data); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }}>
    <div className="plugin-search-setting-copy">
      <label htmlFor={id}>{zh ? '默认搜索结果数' : 'Default search results'}</label>
      <p id={`${id}-help`}>{zh
        ? `Skill 与 MCP 工具搜索共用，可设置 1–${MAX_SEARCH_RESULT_LIMIT} 条；单次搜索可另行指定。`
        : `Shared by Skill and MCP tool searches, from 1 to ${MAX_SEARCH_RESULT_LIMIT}. Individual searches can override this.`}</p>
    </div>
    <div className="plugin-search-setting-controls">
      <input id={id} type="number" min={1} max={MAX_SEARCH_RESULT_LIMIT} step={1} value={draft} disabled={busy}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={Boolean(error)}
        onChange={event => { setDraft(event.target.value); setError(''); }}/>
      <button className="plugin-back" type="submit" disabled={busy || draft === String(value)}>
        {zh ? '保存' : 'Save'}
      </button>
    </div>
    {error && <p id={`${id}-error`} className="plugin-market-error" role="alert">{error}</p>}
  </form>;
}
