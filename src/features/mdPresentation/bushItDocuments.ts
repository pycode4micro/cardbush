const OPEN_DOCUMENT_EVENT = 'cardbush-bush-it-document';
export type CreationDocumentRequest = { source: string; team?: { id: string; revision: number } };
let pending: CreationDocumentRequest | undefined;

export function openBushItDocument(source: string, team?: CreationDocumentRequest['team']) {
  pending = { source, team };
  window.dispatchEvent(new CustomEvent('cardbush-open-application', { detail: { id: 'builtin:md-presentation' } }));
  window.dispatchEvent(new Event(OPEN_DOCUMENT_EVENT));
}
export function takeBushItDocumentRequest() { const request = pending; pending = undefined; return request; }
export function takeBushItDocument() { return takeBushItDocumentRequest()?.source; }
export function watchBushItDocument(listener: () => void) {
  window.addEventListener(OPEN_DOCUMENT_EVENT, listener);
  return () => window.removeEventListener(OPEN_DOCUMENT_EVENT, listener);
}
