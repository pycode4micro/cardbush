import { useCallback } from 'react';

/** Only offsets are retained, so detail pages and their embedded documents can unload. */
export type PageOffsets = Map<string, number>;

export function usePageScroll(offsets: PageOffsets, key: string, axis: 'scrollTop' | 'scrollLeft' = 'scrollTop') {
  return useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const target = offsets.get(key) ?? 0;
    let restoring = true;
    let resize: ResizeObserver | undefined, content: MutationObserver | undefined;
    let input: AbortController | undefined;
    const stop = () => {
      restoring = false;
      resize?.disconnect();
      content?.disconnect();
      input?.abort();
    };
    const restore = () => {
      if (!restoring) return;
      node.scrollTo(axis === 'scrollTop' ? {top: target, behavior: 'instant'} : {left: target, behavior: 'instant'});
      if (Math.abs(node[axis] - target) < 1) stop();
    };
    const remember = () => {
      if (restoring || !node.getClientRects().length) return;
      offsets.delete(key);
      offsets.set(key, node[axis]);
      if (offsets.size > 80) offsets.delete(offsets.keys().next().value!);
    };
    restore();
    if (restoring) {
      // Runtime data, project portals and widgets may arrive after the first layout.
      const observer = new ResizeObserver(restore);
      resize = observer;
      const watchChildren = () => {
        observer.disconnect();
        observer.observe(node);
        for (const child of node.children) observer.observe(child);
      };
      content = new MutationObserver(watchChildren);
      content.observe(node, { childList: true });
      watchChildren();
      input = new AbortController();
      const interrupt = () => { stop(); remember(); };
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        node.addEventListener(event, interrupt, { passive: true, signal: input.signal });
      }
    }
    node.addEventListener('scroll', remember, { passive: true });
    return () => {
      remember();
      stop();
      node.removeEventListener('scroll', remember);
    };
  }, [offsets, key, axis]);
}
