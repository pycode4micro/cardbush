import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { isAssistantPageMessage, type ConversationEntry } from '@cardbush/bush-protocol';
import type { AssistantSurface, AssistantSurfaceState } from '../../../electron/assistantSurface';

import { readAssistantReceipt, saveAssistantReceipt, observeAssistantReceipt } from './assistantReadReceipt';

export function useFloatingAssistant(floating: boolean, active: boolean, entries: ConversationEntry[], generation?: number) {
  const [layout, setLayout] = useState<AssistantSurfaceState>({surface: 'capsule'});
  const { surface } = layout;
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus() && !document.hidden);
  const [receipt, setReceipt] = useState(readAssistantReceipt);
  useEffect(() => observeAssistantReceipt(() => setReceipt(readAssistantReceipt())), []);
  useLayoutEffect(() => {
    if (!floating) { setLayout({surface: 'capsule'}); setHost(null); return; }
    let live = true, changed = false;
    setHost(document.querySelector('.app'));
    const api = window.cardbushDesktop;
    const off = api?.onAssistantSurface?.(value => { changed = true; setLayout(value); });
    void api?.assistantSurface?.('read').then(value => { if (live && !changed) setLayout(value); });
    return () => { live = false; off?.(); };
  }, [floating]);
  useEffect(() => {
    if (!active) return;
    const sync = () => setFocused(document.hasFocus() && !document.hidden);
    sync(); window.addEventListener('focus', sync); window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('focus', sync); window.removeEventListener('blur', sync); document.removeEventListener('visibilitychange', sync); };
  }, [active]);
  const replies = useMemo(() => entries.filter(e => e.role === 'assistant' && isAssistantPageMessage(e)), [entries]);
  const latest = replies.at(-1);
  useEffect(() => {
    if (generation === undefined || !active) return;
    const reading = focused && (!floating || surface === 'replies');
    if (!reading && receipt) return;
    saveAssistantReceipt({ generation, id: latest?.id ?? '', at: latest?.createdAt ?? '' });
  }, [active, floating, focused, generation, latest, receipt, surface]);
  const unread = useMemo(() => {
    if (!receipt || generation === undefined) return 0;
    const index = replies.findIndex(entry => entry.id === receipt.id);
    return index < 0 ? replies.filter(entry => entry.createdAt > receipt.at).length : replies.length - index - 1;
  }, [generation, receipt, replies]);
  return { ...layout, host, unread, replies, show: (next: AssistantSurface) => window.cardbushDesktop?.assistantSurface?.(next) };
}
