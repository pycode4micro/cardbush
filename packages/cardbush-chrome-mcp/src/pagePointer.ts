import { ChromeConnectorError } from './bridgeClient.js';
import type { PageCommand } from './pageCapture.js';

type Point = { x: number; y: number };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

// Runs in the target node's own frame. Only an explicit HTML label relationship may
// substitute for a control with no area; never click an arbitrary ancestor instead.
const chooseTarget = `function(click) {
  const source = this.nodeType === 3 ? this.parentElement : this;
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const usable = element => {
    if (!element?.isConnected || !element.getClientRects) return false;
    for (let node = element; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || node.inert) return false;
      if (click && (node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true')) return false;
    }
    return true;
  };
  if (!usable(source)) throw new Error('The requested element is detached, hidden, inert, or disabled.');
  const hasArea = element => Array.from(element.getClientRects()).some(rect => rect.width >= 1 && rect.height >= 1);
  let target = source;
  if (!hasArea(target)) {
    target = Array.from(source.labels || []).find(label => label.control === source && usable(label) && hasArea(label));
    if (!target) throw new Error('The requested element has no clickable area or visible associated label.');
  }
  target.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
  return target;
}`;

const checkTarget = `function(source, hit, click) {
  source = source.nodeType === 3 ? source.parentElement : source;
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const usable = element => {
    if (!element?.isConnected || !element.getClientRects) return false;
    for (let node = element; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || node.inert) return false;
      if (click && (node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true')) return false;
    }
    return true;
  };
  if (!usable(source) || !usable(this)) return false;
  if (this !== source && !(this.localName === 'label' && this.control === source)) return false;
  if (!Array.from(this.getClientRects()).some(rect => rect.width >= 1 && rect.height >= 1)) return false;
  for (let node = hit; node; node = parent(node)) if (node === this) return {target: this === source ? 'element' : 'associated_label'};
  return false;
}`;

/** Clip quads, including rotated/multiline targets, before choosing an interior point. */
function pointsInViewport(quads: unknown, width: number, height: number): Point[] {
  const points: Point[] = [];
  for (const candidate of Array.isArray(quads) ? quads : []) {
    if (!Array.isArray(candidate) || candidate.length !== 8 || candidate.some(n => typeof n !== 'number' || !Number.isFinite(n))) continue;
    let polygon: Point[] = Array.from({ length: 4 }, (_, i) => ({ x: candidate[i * 2], y: candidate[i * 2 + 1] }));
    for (const [axis, boundary, direction] of [['x', 0, 1], ['x', width - 1, -1], ['y', 0, 1], ['y', height - 1, -1]] as const) {
      const clipped: Point[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const aInside = (a[axis] - boundary) * direction >= 0, bInside = (b[axis] - boundary) * direction >= 0;
        if (aInside) clipped.push(a);
        if (aInside !== bInside) {
          const t = (boundary - a[axis]) / (b[axis] - a[axis]);
          clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
      polygon = clipped;
    }
    const area = Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
    if (area < 1) continue;
    const center = { x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length, y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length };
    for (const p of [center, ...polygon.map(p => ({ x: (p.x + center.x) / 2, y: (p.y + center.y) / 2 }))]) {
      const point = { x: Math.round(p.x), y: Math.round(p.y) };
      if (!points.some(p => p.x === point.x && p.y === point.y)) points.push(point);
    }
    if (points.length >= 15) break;
  }
  return points.slice(0, 15);
}

export async function dispatchPointer(command: PageCommand, uid: string, action: 'click' | 'hover', doubleClick = false) {
  const handles = new Set<string>();
  let attemptedPresses = 0, completedClicks = 0, mouseMoved = false;
  let hitTest: { viewport: Point; document: Point; scroll: Point } | undefined;
  const resolve = async (backendNodeId: number) => {
    const result = object(await command('DOM.resolveNode', { backendNodeId }));
    const id = object(result.object).objectId;
    if (typeof id !== 'string') throw new ChromeConnectorError('element_not_found', `${uid} is no longer available. Take a fresh snapshot.`);
    handles.add(id); return id;
  };
  const call = async (objectId: string, functionDeclaration: string, args: Record<string, unknown>[], returnByValue = true) => {
    const result = object(await command('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, returnByValue }));
    if (result.exceptionDetails) {
      const exception = object(object(result.exceptionDetails).exception);
      throw new ChromeConnectorError('element_not_actionable', String(exception.description ?? 'The element is no longer actionable.').split('\n')[0].slice(0, 400));
    }
    return object(result.result);
  };
  try {
    const sourceId = await resolve(Number(uid.slice(3)));
    const chosen = await call(sourceId, chooseTarget, [{ value: action === 'click' }], false);
    const targetId = chosen.objectId;
    if (typeof targetId !== 'string') throw new ChromeConnectorError('element_not_actionable', `${uid} has no visible pointer target.`);
    handles.add(targetId);
    const described = object(await command('DOM.describeNode', { objectId: targetId }));
    const targetBackendId = Number(object(described.node).backendNodeId);
    const targetUid = `cb_${targetBackendId}`;
    const model = object(await command('DOM.getContentQuads', { objectId: targetId }));
    const metrics = object(await command('Page.getLayoutMetrics'));
    const viewport = object(metrics.cssVisualViewport);
    const width = Number(viewport.clientWidth), height = Number(viewport.clientHeight);
    if (!(width > 0 && height > 0)) throw new ChromeConnectorError('viewport_unavailable', 'No usable page viewport. Take a fresh snapshot.');
    const candidates = pointsInViewport(model.quads, width, height);
    if (!candidates.length) throw new ChromeConnectorError('element_no_area', `${uid} has no clickable area in the viewport.`, { uid });
    const frameTree = object(await command('Page.getFrameTree')).frameTree;
    const ancestors = (value: unknown, id: unknown, owners: string[] = []): string[] | undefined => {
      const tree = object(value), frameId = object(tree.frame).id;
      if (frameId === id) return owners;
      for (const child of Array.isArray(tree.childFrames) ? tree.childFrames : []) {
        const found = ancestors(child, id, [...owners, String(object(object(child).frame).id)]);
        if (found) return found;
      }
      return undefined;
    };
    const framesVisible = async (frameId: unknown) => {
      const owners = ancestors(frameTree, frameId);
      if (!owners) return false;
      // Frame owners are checked in their own contexts: cross-origin restrictions
      // must not let a transparent/inert iframe receive an invisible click.
      for (const id of owners) {
        const owner = object(await command('DOM.getFrameOwner', { frameId: id }));
        const ownerId = await resolve(Number(owner.backendNodeId));
        try {
          const checked = object((await call(ownerId, checkTarget, [{ objectId: ownerId }, { objectId: ownerId }, { value: action === 'click' }])).value);
          if (checked.target !== 'element') return false;
        } finally {
          await command('Runtime.releaseObject', { objectId: ownerId }).catch(() => {}); handles.delete(ownerId);
        }
      }
      return true;
    };
    let lastHitUid: string | undefined;
    let targetKind = 'element';
    const hitsTarget = async (point: Point) => {
      // Quads and mouse input use viewport coordinates; DOM hit testing uses
      // document coordinates. Refresh after hover/each press, which may scroll.
      const current = object(object(await command('Page.getLayoutMetrics')).cssVisualViewport);
      const scroll = { x: Number(current.pageX), y: Number(current.pageY) };
      if (!Number.isFinite(scroll.x) || !Number.isFinite(scroll.y)) {
        throw new ChromeConnectorError('viewport_unavailable', 'No usable page scroll position. Take a fresh snapshot.');
      }
      const documentPoint = { x: Math.round(point.x + scroll.x), y: Math.round(point.y + scroll.y) };
      hitTest = { viewport: point, document: documentPoint, scroll };
      lastHitUid = undefined;
      if (point.x < 0 || point.y < 0 || point.x >= Number(current.clientWidth) || point.y >= Number(current.clientHeight)) return false;
      let hit: Record<string, unknown>;
      try {
        hit = object(await command('DOM.getNodeForLocation', { ...documentPoint, includeUserAgentShadowDOM: true, ignorePointerEventsNone: false }));
      } catch (error) {
        // A geometric miss is not a disconnected connector. Other transport
        // errors still stop the action; never retry an uncertain mouse press.
        if (error instanceof Error && /No node found at given location/.test(error.message)) return false;
        throw error;
      }
      const backendId = Number(hit.backendNodeId);
      lastHitUid = Number.isSafeInteger(backendId) ? `cb_${backendId}` : undefined;
      if (!lastHitUid) return false;
      const hitId = backendId === targetBackendId ? targetId : await resolve(backendId);
      try {
        const checked = object((await call(targetId, checkTarget, [{ objectId: sourceId }, { objectId: hitId }, { value: action === 'click' }])).value);
        if (checked.target !== 'element' && checked.target !== 'associated_label') return false;
        if (!await framesVisible(hit.frameId)) return false;
        targetKind = checked.target;
        return true;
      } catch (error) {
        // An overlay in a different frame cannot be passed into this execution
        // context. Treat it as a non-hit, never as permission to click the frame.
        if (error instanceof Error && /same JavaScript world|same execution context|different JavaScript world/i.test(error.message)) return false;
        throw error;
      } finally {
        if (hitId !== targetId) { await command('Runtime.releaseObject', { objectId: hitId }).catch(() => {}); handles.delete(hitId); }
      }
    };
    let point: Point | undefined;
    for (const candidate of candidates) if (await hitsTarget(candidate)) { point = candidate; break; }
    if (!point) throw new ChromeConnectorError('element_obscured', `${uid} is covered, clipped, or does not receive pointer events. Inspect the page before retrying.`, { uid, hitUid: lastHitUid });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    mouseMoved = true;
    if (action === 'click') {
      const clicks = doubleClick ? 2 : 1;
      for (let clickCount = 1; clickCount <= clicks; clickCount++) {
        // Hover handlers and the first click of a double-click may change layout.
        if (!await hitsTarget(point)) throw new ChromeConnectorError('element_changed', `${uid} changed or became covered before the click. Take a fresh snapshot.`, { uid, hitUid: lastHitUid });
        attemptedPresses++;
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount });
        completedClicks++;
      }
    }
    return { uid, targetUid, target: targetKind, ...point,
      clicks: completedClicks, status: 'input_dispatched', inputDispatched: true, hitTargetVerified: true, outcomeVerified: false };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const normalized = error instanceof ChromeConnectorError ? error : new ChromeConnectorError('pointer_action_failed', error instanceof Error ? error.message : String(error));
    throw new ChromeConnectorError(normalized.code, `${normalized.message}${attemptedPresses ? ' A click may have taken effect; observe before retrying.' : ' No click was sent.'}`, {
      ...normalized.details, uid, mouseMoved, attemptedPresses, completedClicks, ...(hitTest ? { hitTest } : {}),
      inputDispatched: attemptedPresses ? 'possibly' : false, outcomeVerified: false,
    });
  } finally {
    await Promise.all([...handles].map(objectId => command('Runtime.releaseObject', { objectId }).catch(() => {})));
  }
}
