import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ConversationEntry } from '@cardbush/bush-protocol';
import type { AssistantSurface } from '../../../electron/assistantSurface';

const readKey = 'cardbush_assistant_read_receipt';
type Receipt = { generation: number; id: string; at: string };
function readReceipt(): Receipt | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(readKey) ?? 'null');
    if (value && typeof value.generation === 'number' && typeof value.id === 'string' && typeof value.at === 'string') return value;
  } catch { /* Initialize the read position from the first available journal. */ }
}

export function useFloatingAssistant(floating: boolean, active: boolean, entries: ConversationEntry[], generation?: number) {
  const [surface, setSurface] = useState<AssistantSurface>('capsule');
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus() && !document.hidden);
  const [receipt, setReceipt] = useState(readReceipt);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (!event.key || event.key === readKey) setReceipt(readReceipt()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useLayoutEffect(() => {
    if (!floating) { setSurface('capsule'); setHost(null); return; }
    let live = true, changed = false;
    setHost(document.querySelector('.app'));
    const api = window.cardbushDesktop;
    const off = api?.onAssistantSurface?.(value => { changed = true; setSurface(value); });
    void api?.assistantSurface?.('read').then(value => { if (live && !changed) setSurface(value); });
    return () => { live = false; off?.(); };
  }, [floating]);
  useEffect(() => {
    if (!active) return;
    const sync = () => setFocused(document.hasFocus() && !document.hidden);
    sync(); window.addEventListener('focus', sync); window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('focus', sync); window.removeEventListener('blur', sync); document.removeEventListener('visibilitychange', sync); };
  }, [active]);
  const replies = useMemo(() => entries.filter(e => e.role === 'assistant' && e.visibility !== 'internal' && e.source !== 'voice'), [entries]);
  const latest = replies.at(-1);
  useEffect(() => {
    if (generation === undefined || !active) return;
    const reading = focused && (!floating || surface === 'replies');
    if (!reading && receipt?.generation === generation) return;
    if (receipt && (receipt.generation > generation || receipt.generation === generation && receipt.at > (latest?.createdAt ?? ''))) return;
    if (receipt?.generation === generation && receipt.id === (latest?.id ?? '')) return;
    const next = { generation, id: latest?.id ?? '', at: latest?.createdAt ?? '' };
    localStorage.setItem(readKey, JSON.stringify(next)); setReceipt(next);
  }, [active, floating, focused, generation, latest, receipt, surface]);
  const unread = useMemo(() => {
    if (!receipt || generation !== receipt.generation) return 0;
    const index = replies.findIndex(entry => entry.id === receipt.id);
    return index < 0 ? replies.filter(entry => entry.createdAt > receipt.at).length : replies.length - index - 1;
  }, [generation, receipt, replies]);
  return { surface, host, unread, replies, show: (next: AssistantSurface) => window.cardbushDesktop?.assistantSurface?.(next) };
}
