import { useUiLanguage } from '../../i18n/react';
import { uiText } from '../../i18n';
import { useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { browserTabReferenceHref, type BrowserTabReference, type BrowserTabOpenResult } from '@cardbush/bush-protocol';
import { openBrowserTabReference } from './browserTabReferences';

export function BrowserTabReferenceLink({ reference, language: selectedLanguage }: { reference: BrowserTabReference; language?: string }) {
  const inheritedLanguage = useUiLanguage();
  const language = selectedLanguage ?? inheritedLanguage;
  const [result, setResult] = useState<BrowserTabOpenResult>();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const open = async (reopen = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { setResult(await openBrowserTabReference(reference, reopen)); }
    catch (error) { setResult({ status: 'unavailable', message: String(error) }); }
    finally { pending.current = false; setBusy(false); }
  };
  return <span className="browser-tab-reference">
    <a className="context-reference-token" href={browserTabReferenceHref(reference)} title={reference.url}
      aria-busy={busy} onClick={event => { event.preventDefault(); void open(); }}>
      <Globe size={16}/><span>{reference.title}</span>
    </a>
    {result && result.status !== 'opened' && <span role="status" className="browser-tab-reference-status" title={result.message}>
      {result.status === 'missing' ? uiText(language)('browserTabReferenceLink.tabClosed') : uiText(language)('browserTabReferenceLink.tabUnavailable')}
      {result.status === 'missing' && <button type="button" disabled={busy} onClick={() => void open(true)}>{uiText(language)('browserTabReferenceLink.reopen')}</button>}
    </span>}
  </span>;
}
