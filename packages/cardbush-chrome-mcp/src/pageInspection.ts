import { ChromeConnectorError } from './bridgeClient.js';
import type { PageCommand } from './pageCapture.js';

export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

// Read in the element's own frame, including shadow ancestors. These facts do
// not prove clickability: pointer actions must still check the actual hit target.
export const inspectElement = `function() {
  const element = this.nodeType === 3 ? this.parentElement : this;
  if (!element?.isConnected || !element.getBoundingClientRect) return {connected:false};
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
  let hidden = false, disabled = false, inert = false;
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  for (let node = element; node; node = parent(node)) {
    const css = getComputedStyle(node);
    hidden ||= css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0;
    disabled ||= node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true';
    inert ||= node.inert === true;
    if (node !== element) {
      const box = node.getBoundingClientRect();
      if (['hidden','clip','scroll','auto'].includes(css.overflowX)) {left=Math.max(left,box.left);right=Math.min(right,box.right)}
      if (['hidden','clip','scroll','auto'].includes(css.overflowY)) {top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom)}
    }
  }
  const hasArea = Array.from(element.getClientRects()).some(box=>box.width>=1 && box.height>=1);
  const inViewport = rect.right>0 && rect.bottom>0 && rect.left<innerWidth && rect.top<innerHeight;
  const state = {};
  for (const key of ['busy','expanded','checked','selected','hidden','haspopup']) {
    const value = element.getAttribute('aria-'+key);
    if (value !== null) state[key] = value==='true' ? true : value==='false' ? false : value.slice(0,80);
  }
  if ('checked' in element) state.checked = element.indeterminate ? 'mixed' : element.checked;
  if ('selected' in element) state.selected = element.selected;
  const value = element.localName==='input' && ['password','hidden'].includes(element.type) ? undefined
    : 'value' in element ? String(element.value) : element.isContentEditable ? element.textContent || '' : undefined;
  return {connected:true, tag:element.localName, role:element.getAttribute('role'),
    name:(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || '').trim().slice(0,120),
    rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, hasArea, hidden, disabled, inert, inViewport,
    fullyClipped:hasArea && inViewport && (right<=left || bottom<=top), pointerEvents:style.pointerEvents,
    position:style.position,zIndex:style.zIndex,state,
    ...(value===undefined ? {} : {value:value.slice(0,500),valueTruncated:value.length>500}),
    focused:element.getRootNode().activeElement===element};
}`;

export async function callElement(command: PageCommand, objectId: string, declaration = inspectElement, args: unknown[] = []) {
  const response = record(await command('Runtime.callFunctionOn', { objectId, functionDeclaration: declaration,
    arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true }));
  if (response.exceptionDetails) throw new ChromeConnectorError('element_inspection_failed', 'The element could not be inspected. Take a fresh snapshot.');
  return record(record(response.result).value);
}

export async function readElement(command: PageCommand, uid: string, declaration = inspectElement, args: unknown[] = []) {
  const response = record(await command('DOM.resolveNode', { backendNodeId: Number(uid.slice(3)) }));
  const objectId = record(response.object).objectId;
  if (typeof objectId !== 'string') throw new ChromeConnectorError('element_not_found', `${uid} is no longer available. Take a fresh snapshot.`);
  try { return await callElement(command, objectId, declaration, args); }
  finally { await command('Runtime.releaseObject', { objectId }).catch(() => {}); }
}

export function obstructionReason(facts: Record<string, unknown>): string | undefined {
  if (facts.connected === false) return 'detached';
  if (facts.inert === true) return 'inert';
  if (facts.disabled === true) return 'disabled';
  if (facts.hidden === true) return 'hidden';
  if (facts.hasArea === false) return 'zero_size';
  if (facts.inViewport === false) return 'offscreen';
  if (facts.fullyClipped === true) return 'clipped';
  // A descendant can override pointer-events. This only diagnoses a failed hit,
  // never rejects a successful hit or labels a snapshot element unclickable.
  if (facts.pointerEvents === 'none') return 'pointer_events_none';
  return undefined;
}
