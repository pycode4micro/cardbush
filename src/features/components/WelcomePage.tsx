import { useContext, useRef, type CSSProperties, type ReactNode, type RefObject, type PointerEvent } from 'react';
import type { AppLanguage } from '../../types';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import { StarWordmark } from '../chat/StarWordmark';
import { WelcomeSuggestions } from '../chat/WelcomeSuggestions';
import { BuiltinComponentSurface } from './BuiltinComponentSurface';
import { HtmlComponentContext } from './HtmlComponentContext';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import { defaultWelcomeIds, isBuiltinComponent, welcomeComposerFlow, type BuiltinKind, type ComponentCollection, type ComponentItem, type WelcomeLayout, type WelcomePlacement } from './componentModel';
import { useWelcomeLayout } from './useWelcomeLayout';
import './welcomeLayout.css';

// Both the new-conversation page and its editor use these same live component views.
export function WelcomePage({ language, collection, layout, slots = {}, editing = false, canvasRef, controls, onMove, overlay, minHeight = 0 }: {
  language: AppLanguage; collection: ComponentCollection; layout?: WelcomeLayout;
  slots?: Partial<Record<BuiltinKind, ReactNode>>; editing?: boolean;
  canvasRef?: RefObject<HTMLDivElement | null>;
  controls?: (item: ComponentItem) => ReactNode;
  onMove?: (event: PointerEvent, item: ComponentItem) => void;
  overlay?: ReactNode; minHeight?: number;
}) {
  const host = useContext(HtmlComponentContext), zh = language === 'zh';
  const internalRef = useRef<HTMLDivElement>(null), pageRef = canvasRef ?? internalRef;
  const flow = welcomeComposerFlow({ ...collection, welcomeLayout: layout });
  useWelcomeLayout(pageRef, layout, flow, collection, editing);
  function content(item: ComponentItem, placement?: WelcomePlacement) {
    if (!isBuiltinComponent(item)) return <HtmlComponentSurface component={item} active={!editing}/>;
    const inputStyle = placement?.inputStyle ?? item.inputStyle ?? 'standard';
    if (item.builtin === 'input') return <ComposerPresentationContext.Provider value={{ style: inputStyle, preview: editing }}>
      <div className={`welcome-input-stack builtin-input ${inputStyle}`}>{slots.input ?? host?.composer}</div>
    </ComposerPresentationContext.Provider>;
    if (slots[item.builtin] !== undefined) return slots[item.builtin];
    if (item.builtin === 'brand') return <StarWordmark/>;
    if (item.builtin === 'greeting') return <h2>{zh ? '你想做些什么？' : 'What would you like to do?'}</h2>;
    if (item.builtin === 'suggestions') return <WelcomeSuggestions language={language} disabled={!host || host.running} hasDraft={Boolean(host?.draft?.trim())}
      onSelect={suggestion => host?.selectSuggestion ? host.selectSuggestion(suggestion) : host?.fill(suggestion.text)}/>;
    return <BuiltinComponentSurface component={item} language={language}/>;
  }
  function view(id: string, placement?: WelcomePlacement) {
    const item = collection.items.find(candidate => candidate.id === id); if (!item) return null;
    return <div key={id} data-welcome-component={id} className={`welcome-layout-slot ${isBuiltinComponent(item) ? `welcome-slot-${item.builtin}` : 'welcome-slot-html'}`}
      onPointerDown={event => { if (!(event.target as Element).closest('button')) onMove?.(event, item); }}
      style={placement && id !== 'system-input' ? { left: `${placement.x}%`, top: `calc(${placement.y}px * var(--welcome-height-scale, 1))`,
        width: `${placement.width}%`, height: `calc(${placement.height}px * var(--welcome-height-scale, 1))` } as CSSProperties : undefined}>
      <div className="welcome-slot-content" inert={editing || undefined}>{content(item, placement)}</div>
      {controls?.(item)}
    </div>;
  }
  const landing = editing && flow.afterSend === 'bottom' && (layout?.items.some(item => item.componentId === 'system-input') ?? true)
    ? <div className="welcome-composer-landing" role="note">
      <span className="welcome-composer-landing-label">
        <span className="composer-will-move">{zh ? '发送后落点 · 下移 ' : 'After sending · Move down '}<span data-composer-travel/></span>
        <span className="composer-stays">{zh ? '已吸附底部 · 发送后不移动' : 'Docked · Stays here after sending'}</span>
      </span>
    </div> : null;
  return <div className={`welcome-composer welcome-layout-surface ${layout ? 'custom-layout' : 'default-layout'}${editing ? ' is-editing' : ''}`} ref={pageRef}>
    {layout ? <div className="welcome-layout-canvas" style={{ minHeight: `max(${minHeight}px, calc(${Math.max(0, ...layout.items.filter(item => item.componentId !== 'system-input').map(item => item.y + item.height))}px * var(--welcome-height-scale, 1) + 20px))` }}>
      {layout.items.map(item => view(item.componentId, item))}
      {landing}
      {overlay}
    </div> : <>
      <div className="welcome-hero">{defaultWelcomeIds.slice(0, 3).map(id => view(id))}</div>
      {view('system-input')}
      {landing}
    </>}
  </div>;
}
