import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

export type CapsuleInput = {
  composing: boolean; voiceOpen: boolean; repliesOpen: boolean; ready: boolean; sending: boolean;
  draft: string; changeDraft(value: string): void; files: string[]; changeFiles(files: string[]): void;
  collapse(): void; send(text: string): Promise<boolean>;
};

export function useCapsuleControls(p: CapsuleInput) {
  const input = useRef<HTMLInputElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const previous = useRef<'compose' | 'voice' | undefined>(undefined);
  const sheet = useRef<HTMLElement>(null);
  const { repliesOpen, collapse } = p;
  useEffect(() => {
    if (!repliesOpen) return;
    // A completed click lets the toolbar's drag handler suppress a drag first.
    const dismissOutside = (event: MouseEvent) => {
      const path = event.composedPath();
      if (sheet.current && path.includes(sheet.current)) return;
      if (toolbar.current && path.includes(toolbar.current) &&
          path.some(node => node instanceof HTMLButtonElement && !node.disabled)) return;
      collapse();
    };
    document.addEventListener('click', dismissOutside);
    return () => document.removeEventListener('click', dismissOutside);
  }, [repliesOpen, collapse]);
  const [limit, setLimit] = useState(30);
  useLayoutEffect(() => {
    const node = sheet.current;
    if (!node) { setLimit(30); return; }
    const measure = () => window.cardbushDesktop?.measureAssistantReplies?.(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [p.repliesOpen]);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{id:number; x:number; y:number; moved:boolean} | undefined>(undefined);
  const suppressClick = useRef(false);
  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('input,textarea,[contenteditable=true]')) return;
    suppressClick.current = false;
    drag.current = { id:event.pointerId, x:event.screenX, y:event.screenY, moved:false };
    const target = (event.target as Element).closest('button') ?? event.currentTarget;
    target.setPointerCapture(event.pointerId);
    window.cardbushDesktop?.dragAssistantSurface?.('start');
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.id !== event.pointerId) return;
    const dx = Math.round(event.screenX-start.x), dy = Math.round(event.screenY-start.y);
    if (!start.moved && Math.hypot(dx,dy) < 5) return;
    start.moved = true;
    window.cardbushDesktop?.dragAssistantSurface?.('move',dx,dy);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    suppressClick.current = drag.current.moved;
    drag.current = undefined;
    window.cardbushDesktop?.dragAssistantSurface?.('end');
  };
  useLayoutEffect(() => {
    if (p.composing) {
      previous.current = 'compose';
      input.current?.focus();
    } else if (p.voiceOpen) {
      previous.current = 'voice';
      toolbar.current?.querySelector('button')?.focus({preventScroll:true});
    } else if (previous.current) {
      if (document.hasFocus()) toolbar.current?.querySelector<HTMLButtonElement>(`[data-action="${previous.current}"]`)?.focus({preventScroll:true});
      previous.current = undefined;
    }
  }, [p.composing, p.voiceOpen]);
  const submit = async () => {
    if (!p.ready || p.sending || (!p.draft.trim() && !p.files.length)) return;
    const text = [p.draft, ...p.files.map(path => '@"' + path + '"')].filter(Boolean).join('\n');
    if (await p.send(text)) { p.changeDraft(''); p.changeFiles([]); setFailed(false); p.collapse(); }
    else { setFailed(true); input.current?.focus(); }
  };
  const attach = async () => {
    try {
      const paths = await window.cardbushDesktop?.pickAttachments?.();
      if (paths?.length) p.changeFiles([...new Set([...p.files, ...paths])]);
    } catch { setFailed(true); }
    input.current?.focus();
  };
  return {input, toolbar, sheet, limit, setLimit, failed, setFailed, suppressClick, beginDrag, moveDrag, endDrag, submit, attach};
}
