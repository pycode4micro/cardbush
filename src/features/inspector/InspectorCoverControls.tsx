import { uiText } from '../../i18n';
import { AlertCircle, ArrowLeft, CheckCircle2, GripVertical, LoaderCircle, MessageSquare } from 'lucide-react';
import type { QuickInputState } from '../composer/quickInputState';
import type { AppLanguage } from '../../types';
import { useInspectorCoverPosition } from './useInspectorCoverPosition';

export function InspectorCoverControls({ language, inputOpen, inputPending = false, inert = false, status, onTargetChange, onBack, onToggleInput }: {
  language: AppLanguage;
  inputOpen: boolean;
  inputPending?: boolean;
  inert?: boolean;
  status?: QuickInputState;
  onTargetChange: (target: HTMLDivElement | null) => void;
  onBack?: () => void;
  onToggleInput: () => void;
}) {
  const floating = useInspectorCoverPosition(inputOpen, inert);

  const collapsedStatus = !inputOpen && status?.hasActivity ? status : undefined;
  const Icon = collapsedStatus && { alert: AlertCircle, working: LoaderCircle, complete: CheckCircle2, chat: MessageSquare }[collapsedStatus.icon];
  return <div className="inspector-cover-controls" ref={floating.root} inert={inert}>
    {inputOpen && <div className="inspector-quick-input" ref={onTargetChange} aria-label={uiText(language)('inspectorCoverControls.quickInput')} aria-busy={inputPending}>
      {inputPending && <p className="quick-input-loading" role="status">{uiText(language)('inspectorCoverControls.preparingConversation')}</p>}
    </div>}
    <div className="inspector-cover-capsule" ref={floating.capsule}>
      {onBack && <button type="button" className="inspector-cover-back" onClick={onBack}><ArrowLeft size={15} />{uiText(language)('windowFrame.back')}</button>}
      <button type="button" className="inspector-cover-drag" aria-label={uiText(language)('inspectorCoverControls.moveInputPanel')}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home" {...floating.handlers}>
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <button type="button" className="inspector-cover-input-toggle" aria-expanded={inputOpen} onClick={onToggleInput}>
        {collapsedStatus && Icon && <span className="inspector-cover-status" data-state={collapsedStatus.state}><Icon size={14}/><span role="status">{collapsedStatus.label}</span></span>}
        {uiText(language)('inspectorCoverControls.input')}
      </button>
    </div>
  </div>;
}
