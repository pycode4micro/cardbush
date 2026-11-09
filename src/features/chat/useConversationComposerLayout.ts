import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

export function useConversationComposerLayout({ bodyRef, dockRef, welcome, loading, interaction }: {
  bodyRef: RefObject<HTMLDivElement | null>; dockRef: RefObject<HTMLDivElement | null>;
  welcome: boolean; loading: boolean; interaction: boolean;
}) {
  const departure = useRef<number | null>(null);
  const capture = useCallback((first: boolean) => {
    const body = bodyRef.current;
    const input = body?.querySelector<HTMLElement>('.new-chat-input .composer-stack');
    if (first && welcome && body && input) {
      const bounds = body.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      departure.current = (inputRect.top + inputRect.height / 2 - bounds.top) / (bounds.height / body.clientHeight || 1);
    }
  }, [bodyRef, welcome]);

  useLayoutEffect(() => {
    if (welcome) return;
    const body = bodyRef.current, dock = dockRef.current;
    if (!body || !dock || loading || interaction) return;
    const input = dock.querySelector<HTMLElement>('.composer-stack');
    let animation: Animation | undefined;
    if (departure.current !== null && input && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const bounds = body.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const end = (inputRect.top + inputRect.height / 2 - bounds.top) / (bounds.height / body.clientHeight || 1);
      if (end > departure.current) animation = input.animate([{transform: 'translateY(' + (departure.current - end) + 'px)'}, {transform: 'none'}],
        { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    departure.current = null;
    return () => animation?.cancel();
  }, [bodyRef, dockRef, welcome, loading, interaction]);
  return { capture };
}
