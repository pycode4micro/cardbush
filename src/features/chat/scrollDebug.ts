import { recordWindowScrollDiagnostic } from './windowScrollDiagnostics';

export function scrollDebugEnabled() {
  try {
    // Session-scoped so a past diagnosis cannot leave IPC logging enabled.
    return window.sessionStorage.getItem('cardbush_scroll_debug') === 'true';
  } catch {
    return false;
  }
}

export function scrollDebug(label: string, data: Record<string, unknown>) {
  recordWindowScrollDiagnostic(label, data);
  if (!scrollDebugEnabled()) return;
  const entry = { at: new Date().toISOString(), label, ...data };
  const buffer = window.__cardbushScrollDebug ?? [];
  buffer.push(entry);
  if (buffer.length > 300) buffer.splice(0, buffer.length - 300);
  window.__cardbushScrollDebug = buffer;
  console.debug('[cardbush:scroll]', entry);
  void window.cardbushDesktop?.writeDebugLog?.('scroll', entry).catch(() => undefined);
}
