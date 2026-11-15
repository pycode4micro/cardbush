import { componentProtocol } from './componentModel';
import frameStyles from './componentFrame.css?inline';
import frameSdk from './componentFrame.js?raw';
import { componentOrigins } from '../../../assets/skills/cardbush-docs/scripts/component-origins.mjs';

/** Standard browser rendering in an opaque origin, with declared resource access. */
export function componentDocument(html: string, token: string, network = false, linkKey?: string, embeds: string[] = [], resources: string[] = []) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('base,meta[http-equiv]').forEach(node => node.remove());
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  const frameSources = componentOrigins(embeds).join(' ') || "'none'";
  const resourceSources = componentOrigins(resources).join(' ');
  policy.content = `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: data: ${resourceSources}; style-src 'unsafe-inline' blob: data: ${resourceSources}; img-src data: blob: ${resourceSources}; font-src data: blob: ${resourceSources}; media-src data: blob: ${resourceSources}; connect-src data: blob: ${resourceSources}; worker-src blob: data: ${resourceSources}; frame-src ${frameSources}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const style = doc.createElement('style');
  style.textContent = frameStyles;
  const script = doc.createElement('script');
  script.dataset.protocol = componentProtocol;
  script.dataset.token = token;
  script.dataset.network = String(network);
  if (linkKey) script.dataset.linkKey = linkKey;
  script.textContent = frameSdk;
  doc.head.prepend(policy, style, script);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
