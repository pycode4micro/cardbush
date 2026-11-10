import { componentProtocol } from './componentModel';
import frameStyles from './componentFrame.css?inline';
import frameSdk from './componentFrame.js?raw';

/** The document stays opaque-origin; HTML cannot access Electron, app storage or network. */
export function componentDocument(html: string, token: string, network = false) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('base,meta[http-equiv]').forEach(node => node.remove());
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const style = doc.createElement('style');
  style.textContent = frameStyles;
  const script = doc.createElement('script');
  script.dataset.protocol = componentProtocol;
  script.dataset.token = token;
  script.dataset.network = String(network);
  script.textContent = frameSdk;
  doc.head.prepend(policy, style, script);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
