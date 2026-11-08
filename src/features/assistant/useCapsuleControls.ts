import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

export type CapsuleInput = {
  composing: boolean; repliesOpen: boolean; ready: boolean; sending: boolean;
  draft: string; changeDraft(value: string): void; files: string[]; changeFiles(files: string[]): void;
  collapse(): void; send(text: string): Promise<boolean>;
};

export function useCapsuleControls(p: CapsuleInput) {
  const input = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const wasComposing = useRef(false);
  const sheet = useRef<HTMLElement>(null);
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
    if (p.composing) input.current?.focus();
    else if (wasComposing.current) launcher.current?.focus({preventScroll:true});
    wasComposing.current = p.composing;
  }, [p.composing]);
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
  return {input, launcher, sheet, limit, setLimit, failed, setFailed, suppressClick, beginDrag, moveDrag, endDrag, submit, attach};
}
