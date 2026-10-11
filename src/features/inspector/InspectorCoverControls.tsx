import { ArrowLeft, GripVertical } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { useInspectorCoverPosition } from './useInspectorCoverPosition';

export function InspectorCoverControls({ language, inputOpen, inert = false, onTargetChange, onBack, onToggleInput }: {
  language: AppLanguage;
  inputOpen: boolean;
  inert?: boolean;
  onTargetChange: (target: HTMLDivElement | null) => void;
  onBack: () => void;
  onToggleInput: () => void;
}) {
  const floating = useInspectorCoverPosition(inputOpen, inert);
  const zh = language === 'zh';
  return <div className="inspector-cover-controls" ref={floating.root} inert={inert}>
    {inputOpen && <div className="inspector-quick-input" ref={onTargetChange} aria-label={zh ? '快速输入' : 'Quick input'} />}
    <div className="inspector-cover-capsule" ref={floating.capsule}>
      <button type="button" className="inspector-cover-back" onClick={onBack}><ArrowLeft size={15} />{zh ? '返回' : 'Back'}</button>
      <button type="button" className="inspector-cover-drag" aria-label={zh ? '移动输入框' : 'Move input panel'}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home" {...floating.handlers}>
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <button type="button" className="inspector-cover-input-toggle" aria-expanded={inputOpen} onClick={onToggleInput}>
        {zh ? '输入' : 'Input'}
      </button>
    </div>
  </div>;
}
