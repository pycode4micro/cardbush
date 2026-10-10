const OPEN_DOCUMENT_EVENT = 'cardbush-bush-it-document';
let pending: string | undefined;

export function openBushItDocument(source: string) {
  pending = source;
  window.dispatchEvent(new CustomEvent('cardbush-open-application', { detail: { id: 'builtin:md-presentation' } }));
  window.dispatchEvent(new Event(OPEN_DOCUMENT_EVENT));
}
export function takeBushItDocument() { const source = pending; pending = undefined; return source; }
export function watchBushItDocument(listener: () => void) {
  window.addEventListener(OPEN_DOCUMENT_EVENT, listener);
  return () => window.removeEventListener(OPEN_DOCUMENT_EVENT, listener);
}
