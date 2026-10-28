import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { normalizeComposerFlow, type ComposerFlow } from './componentModel';

export function ComposerLayoutSettings({ language, flow, onChange }: {
  language: AppLanguage; flow?: ComposerFlow; onChange: (flow: ComposerFlow) => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="composer-layout-settings-button" aria-label={uiText(language)('composerLayoutSettings.composerAndConversationLayout')}
      onClick={() => setOpen(true)}><Settings2 size={14}/></button>
    {open && <FlowDialog language={language} flow={normalizeComposerFlow(flow)} onChange={onChange} onClose={() => setOpen(false)}/>}
  </>;
}

function FlowDialog({ language, flow, onChange, onClose }: {
  language: AppLanguage; flow: ComposerFlow; onChange: (flow: ComposerFlow) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog ref={dialog} className="composer-layout-dialog" aria-label={uiText(language)('composerLayoutSettings.composerAndConversationLayout')}
    onPointerDown={event => event.stopPropagation()} onClose={dialogEventHandler(event => { if (!event.currentTarget.open) onClose(); })}>
    <header><strong>{uiText(language)('composerLayoutSettings.composerAndConversationLayout')}</strong>
      <button type="button" aria-label={uiText(language)('common.close')} onClick={onClose}><X size={16}/></button></header>
    <label>{uiText(language)('composerLayoutSettings.composerPositionAfterSending')}
      <select value={flow.afterSend} onChange={event => onChange({ ...flow, afterSend: event.target.value as ComposerFlow['afterSend'] })}>
        <option value="bottom">{uiText(language)('composerLayoutSettings.moveToBottom')}</option>
        <option value="keep">{uiText(language)('composerLayoutSettings.keepCurrentPosition')}</option>
      </select></label>
    <label>{uiText(language)('composerLayoutSettings.conversationOutputStarts')}
      <select value={flow.output} onChange={event => onChange({ ...flow, output: event.target.value as ComposerFlow['output'] })}>
        <option value="above">{uiText(language)('composerLayoutSettings.aboveTheComposer')}</option>
        <option value="below">{uiText(language)('composerLayoutSettings.belowTheComposer')}</option>
      </select></label>
    <p>{flow.output === 'below'
      ? uiText(language)('composerLayoutSettings.contentGrowsDownwardScrollingPinsTheComposer')
      : flow.afterSend === 'keep'
        ? uiText(language)('composerLayoutSettings.contentStartsAboveAndContinuesBelowLeaving')
        : uiText(language)('composerLayoutSettings.afterSendingTheComposerSitsAtThe')}</p>
    <p>{uiText(language)('composerLayoutSettings.theComposerStaysCenteredAndKeepsIts')}</p>
    <button type="button" className="composer-layout-done" onClick={onClose}>{uiText(language)('composerLayoutSettings.done')}</button>
  </dialog>;
}
