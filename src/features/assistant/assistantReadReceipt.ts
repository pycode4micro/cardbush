export const assistantReadKey = 'cardbush_assistant_read_receipt';
const localChange = 'cardbush:assistant-read-position';
export type AssistantReadReceipt = { generation: number; id: string; at: string };

export function readAssistantReceipt(): AssistantReadReceipt | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(assistantReadKey) ?? 'null');
    if (value && typeof value.generation === 'number' && typeof value.id === 'string' && typeof value.at === 'string') return value;
  } catch { /* A new profile starts at the current journal position. */ }
}

export function saveAssistantReceipt(next: AssistantReadReceipt, reset = false) {
  const current = readAssistantReceipt();
  if (!reset && current && (current.at > next.at || (current.id === next.id && current.at === next.at && current.generation === next.generation))) return;
  localStorage.setItem(assistantReadKey, JSON.stringify(next));
  window.dispatchEvent(new Event(localChange));
}

export function observeAssistantReceipt(changed: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === assistantReadKey) changed(); };
  window.addEventListener('storage', storage);
  window.addEventListener(localChange, changed);
  return () => { window.removeEventListener('storage', storage); window.removeEventListener(localChange, changed); };
}
