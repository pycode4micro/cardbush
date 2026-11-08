import { useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { PageNavigationContext } from './PageNavigation';

type BackTarget = { marker: HTMLElement; run(): void; disabled: boolean };
const targets = new Set<BackTarget>();
const listeners = new Set<() => void>();
let activeTarget: BackTarget | undefined;
const snapshot = () => activeTarget;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function refreshTarget() {
  let current: BackTarget | undefined;
  for (const target of targets) {
    const owner = target.marker.parentElement;
    if (!owner?.isConnected || owner.closest('[inert],[hidden],[aria-hidden="true"]') || !owner.checkVisibility()) continue;
    if (!current || (current.marker.compareDocumentPosition(target.marker) & Node.DOCUMENT_POSITION_FOLLOWING)) current = target;
  }
  if (current === activeTarget) return;
  activeTarget = current;
  listeners.forEach(listener => listener());
}

/** Inner pages can save, dismiss or block a return through the single window control. */
export function WindowBackTarget({ onBack, disabled = false, usePageHistory = false }: {
  onBack: () => void;
  disabled?: boolean;
  usePageHistory?: boolean;
}) {
  const history = useContext(PageNavigationContext);
  const marker = useRef<HTMLSpanElement>(null);
  const action = useRef(onBack);
  useLayoutEffect(() => {
    action.current = () => {
      if (usePageHistory && history?.canGoBack) history.back();
      else onBack();
    };
  }, [onBack, usePageHistory, history]);
  useLayoutEffect(() => {
    const node = marker.current;
    if (!node) return;
    const target = { marker: node, disabled, run: () => action.current() };
    targets.add(target);
    const observer = new MutationObserver(refreshTarget);
    // Parent pages may stay mounted while a sibling page or settings is displayed.
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] });
    refreshTarget();
    return () => {
      observer.disconnect();
      targets.delete(target);
      refreshTarget();
    };
  }, [disabled]);
  return <span hidden ref={marker}/>;
}

export function useWindowBack(fallback?: () => void) {
  const target = useSyncExternalStore(subscribe, snapshot, () => undefined);
  return target ? (target.disabled ? undefined : target.run) : fallback;
}
