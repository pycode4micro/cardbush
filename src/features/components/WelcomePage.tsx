import { useContext, type CSSProperties, type ReactNode, type RefObject, type PointerEvent } from 'react';
import type { AppLanguage } from '../../types';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import { StarWordmark } from '../chat/StarWordmark';
import { WelcomeSuggestions } from '../chat/WelcomeSuggestions';
import { BuiltinComponentSurface } from './BuiltinComponentSurface';
import { HtmlComponentContext } from './HtmlComponentContext';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import { defaultWelcomeIds, isBuiltinComponent, type BuiltinKind, type ComponentCollection, type ComponentItem, type WelcomeLayout, type WelcomePlacement } from './componentModel';
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
      style={placement ? { left: `${placement.x}%`, top: placement.y, width: `${placement.width}%`, height: placement.height } as CSSProperties : undefined}>
      <div className="welcome-slot-content" inert={editing || undefined}>{content(item, placement)}</div>
      {controls?.(item)}
    </div>;
  }
  return <div className={`welcome-composer welcome-layout-surface ${layout ? 'custom-layout' : 'default-layout'}${editing ? ' is-editing' : ''}`} ref={canvasRef}>
    {layout ? <div className="welcome-layout-canvas" style={{ minHeight: Math.max(minHeight, ...layout.items.map(item => item.y + item.height + 20)) }}>
      {layout.items.map(item => view(item.componentId, item))}
      {overlay}
    </div> : <>
      <div className="welcome-hero">{defaultWelcomeIds.slice(0, 3).map(id => view(id))}</div>
      {view('system-input')}
    </>}
  </div>;
}
