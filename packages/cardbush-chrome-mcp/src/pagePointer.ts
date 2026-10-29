import { BrowserConnectorError } from './bridgeClient.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { PageCommand } from './pageCapture.js';
import { callElement, inspectElement, obstructionReason } from './pageInspection.js';

type Point = { x: number; y: number };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

// Runs in the target node's own frame. Only an explicit HTML label relationship may
// substitute for a hidden/zero-area control; never click an arbitrary ancestor instead.
const chooseTarget = `function(click) {
  const source = this.nodeType === 3 ? this.parentElement : this;
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const usable = (element, visible = true) => {
    if (!element?.isConnected || !element.getClientRects) return false;
    for (let node = element; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (node.inert || visible && (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0)) return false;
      if (click && (node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true')) return false;
    }
    return true;
  };
  if (!usable(source, false)) throw new Error('The requested element is detached, inert, or disabled.');
  const hasArea = element => Array.from(element.getClientRects()).some(rect => rect.width >= 1 && rect.height >= 1);
  let target = source;
  if (!usable(target) || !hasArea(target)) {
    target = Array.from(source.labels || []).find(label => label.control === source && usable(label) && hasArea(label));
    if (!target) throw new Error('The requested element has no clickable area or visible associated label.');
  }
  return target;
}`;

const scrollTarget = `function() {
  const positions = [], windows = [];
  let view=window, element=this, complete=true;
  while (view) {
    windows.push([view,view.scrollX,view.scrollY]);
    for (let node=element;node;node=node.parentElement || node.getRootNode()?.host) positions.push([node,node.scrollLeft,node.scrollTop]);
    if (view===view.top) break;
    try { element=view.frameElement;if(!element){complete=false;break}view=view.parent; }
    catch {complete=false;break}
  }
  this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  return {complete,autoScrolled:windows.some(([view,x,y])=>view.scrollX!==x || view.scrollY!==y) || positions.some(([node,left,top])=>node.scrollLeft!==left || node.scrollTop!==top)};
}`;

const stableTarget = `function() {
  return new Promise(resolve=>{
    let previous, frames=0, raf;
    const finish = result=>{clearTimeout(timer);cancelAnimationFrame(raf);resolve({...result,frames,method:'animation_frames'})};
    const timer = setTimeout(()=>finish({stable:false,reason:frames<2?'frames_unavailable':'moving'}),500);
    const sample=()=>{
      if (!this.isConnected) {finish({stable:false,reason:'detached'});return}
      const r=this.getBoundingClientRect(), current=[r.x,r.y,r.width,r.height];frames++;
      if (previous && current.every((v,i)=>Math.abs(v-previous[i])<=0.25)) {finish({stable:true});return}
      previous=current;raf=requestAnimationFrame(sample);
    };
    raf=requestAnimationFrame(sample);
  });
}`;

const targetBounds = `function() {
  if (!this.isConnected) return {connected:false};
  const r=this.getBoundingClientRect();
  return {connected:true,bounds:[r.x,r.y,r.width,r.height]};
}`;

// Hidden/occluded renderers may stop RAF even while CDP and layout remain live.
// Sample through the host clock in that case, without selecting the user's tab
// or weakening the subsequent native hit tests. Moving bounds reset the window.
async function stableBackgroundTarget(command: PageCommand, objectId: string, frames: unknown) {
  const started = Date.now();
  let previous: number[] | undefined, consecutive = 0, samples = 0, stableSince = started;
  while (Date.now() - started < 500) {
    const observation = await callElement(command, objectId, targetBounds);
    samples++;
    const evidence = { method: 'layout_samples', samples, frames, elapsedMs: Date.now() - started };
    if (!observation.connected) return { ...evidence, stable: false, reason: 'detached' };
    const bounds = observation.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      return { ...evidence, stable: false, reason: 'layout_unavailable' };
    }
    if (previous && bounds.every((value, index) => Math.abs(value - previous![index]) <= 0.25)) consecutive++;
    else { consecutive = 1; stableSince = Date.now(); }
    if (consecutive >= 3 && Date.now() - stableSince >= 100) return { ...evidence, stable: true };
    previous = bounds;
    await delay(50);
  }
  return { stable: false, reason: 'moving', method: 'layout_samples', samples, frames, elapsedMs: Date.now() - started };
}

const checkTarget = `function(source, hit, click) {
  source = source.nodeType === 3 ? source.parentElement : source;
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const usable = (element, visible = true) => {
    if (!element?.isConnected || !element.getClientRects) return false;
    for (let node = element; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (node.inert || visible && (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0)) return false;
      if (click && (node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true')) return false;
    }
    return true;
  };
  if (!usable(source, this === source) || !usable(this)) return false;
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
  let attemptedPresses = 0, completedClicks = 0, mouseMoved = false, mouseMoveAttempted = false;
  let sourceId: string | undefined, targetId: string | undefined, lastHitUid: string | undefined;
  let autoScrolled: boolean | 'unknown' = false, stability: Record<string, unknown> | undefined;
  let hitTest: { viewport: Point; document: Point; scroll: Point } | undefined;
  const resolve = async (backendNodeId: number) => {
    const result = object(await command('DOM.resolveNode', { backendNodeId }));
    const id = object(result.object).objectId;
    if (typeof id !== 'string') throw new BrowserConnectorError('element_not_found', `${uid} is no longer available. Take a fresh snapshot.`);
    handles.add(id); return id;
  };
  const call = async (objectId: string, functionDeclaration: string, args: Record<string, unknown>[], returnByValue = true) => {
    const result = object(await command('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, returnByValue, awaitPromise: true }));
    if (result.exceptionDetails) {
      const exception = object(object(result.exceptionDetails).exception);
      throw new BrowserConnectorError('element_not_actionable', String(exception.description ?? 'The element is no longer actionable.').split('\n')[0].slice(0, 400));
    }
    return object(result.result);
  };
  try {
    sourceId = await resolve(Number(uid.slice(3)));
    const chosen = await call(sourceId, chooseTarget, [{ value: action === 'click' }], false);
    if (typeof chosen.objectId !== 'string') throw new BrowserConnectorError('element_not_actionable', `${uid} has no visible pointer target.`);
    targetId = chosen.objectId;
    handles.add(targetId);
    const beforeScroll = object(object(await command('Page.getLayoutMetrics')).cssVisualViewport);
    autoScrolled = 'unknown';
    const scrollObservation = await callElement(command, targetId, scrollTarget);
    const localScroll = scrollObservation.autoScrolled === true;
    if (localScroll) autoScrolled = true;
    const afterScroll = object(object(await command('Page.getLayoutMetrics')).cssVisualViewport);
    if ([beforeScroll.pageX, beforeScroll.pageY, afterScroll.pageX, afterScroll.pageY].every(value => typeof value === 'number' && Number.isFinite(value))) {
      const changed = localScroll || beforeScroll.pageX !== afterScroll.pageX || beforeScroll.pageY !== afterScroll.pageY;
      autoScrolled = changed ? true : scrollObservation.complete === true ? false : 'unknown';
    }
    const ensureStable = async () => {
      stability = await callElement(command, targetId!, stableTarget);
      if (stability.reason === 'frames_unavailable') stability = await stableBackgroundTarget(command, targetId!, stability.frames);
      if (stability.stable !== true) throw new BrowserConnectorError(
        stability.reason === 'layout_unavailable' ? 'page_rendering_unavailable' : 'element_unstable',
        `${uid} did not provide stable layout observations. Inspect the current page before retrying.`,
        { reason: stability.reason === 'detached' || stability.reason === 'layout_unavailable' ? stability.reason : 'unstable', stability });
    };
    await ensureStable();
    const described = object(await command('DOM.describeNode', { objectId: targetId }));
    const targetBackendId = Number(object(described.node).backendNodeId);
    const targetUid = `cb_${targetBackendId}`;
    const model = object(await command('DOM.getContentQuads', { objectId: targetId }));
    const metrics = object(await command('Page.getLayoutMetrics'));
    const viewport = object(metrics.cssVisualViewport);
    const width = Number(viewport.clientWidth), height = Number(viewport.clientHeight);
    if (!(width > 0 && height > 0)) throw new BrowserConnectorError('viewport_unavailable', 'No usable page viewport. Take a fresh snapshot.');
    const candidates = pointsInViewport(model.quads, width, height);
    if (!candidates.length) throw new BrowserConnectorError('element_no_area', `${uid} has no clickable area in the viewport.`, { uid });
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
    let targetKind = 'element';
    const hitsTarget = async (point: Point) => {
      // Quads and mouse input use viewport coordinates; DOM hit testing uses
      // document coordinates. Refresh after hover/each press, which may scroll.
      const current = object(object(await command('Page.getLayoutMetrics')).cssVisualViewport);
      const scroll = { x: Number(current.pageX), y: Number(current.pageY) };
      if (!Number.isFinite(scroll.x) || !Number.isFinite(scroll.y)) {
        throw new BrowserConnectorError('viewport_unavailable', 'No usable page scroll position. Take a fresh snapshot.');
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
      const hitId = backendId === targetBackendId ? targetId! : await resolve(backendId);
      try {
        const checked = object((await call(targetId!, checkTarget, [{ objectId: sourceId }, { objectId: hitId }, { value: action === 'click' }])).value);
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
    if (!point) throw new BrowserConnectorError('element_obscured', `${uid} is covered, clipped, or does not receive pointer events. Inspect the page before retrying.`, { uid, hitUid: lastHitUid });
    mouseMoveAttempted = true;
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    mouseMoved = true;
    if (action === 'click') {
      const clicks = doubleClick ? 2 : 1;
      for (let clickCount = 1; clickCount <= clicks; clickCount++) {
        // Hover handlers and the first click of a double-click may change layout.
        await ensureStable();
        if (!await hitsTarget(point)) throw new BrowserConnectorError('element_changed', `${uid} changed or became covered before the click. Take a fresh snapshot.`, { uid, hitUid: lastHitUid });
        attemptedPresses++;
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount });
        completedClicks++;
      }
    }
    const postState = await callElement(command, sourceId, `function(){return {url:location.href,observedAt:new Date().toISOString(),target:(${inspectElement}).call(this)}}`)
      .catch(() => ({ status: 'unavailable' }));
    return { uid, targetUid, target: targetKind, ...point, autoScrolled, mouseMoved, stability, postState,
      clicks: completedClicks, status: 'input_dispatched', inputDispatched: true, hitTargetVerified: true, outcomeVerified: false };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const normalized = error instanceof BrowserConnectorError ? error : new BrowserConnectorError('pointer_action_failed', error instanceof Error ? error.message : String(error));
    const facts = targetId || sourceId ? await callElement(command, (targetId || sourceId)!).catch(() => ({})) : {};
    const sourceFacts = sourceId && sourceId !== targetId ? await callElement(command, sourceId).catch(() => ({})) : facts;
    let occluder: Record<string, unknown> | undefined, covered = false;
    if (lastHitUid && targetId) {
      try {
        const hitId = await resolve(Number(lastHitUid.slice(3)));
        occluder = { uid: lastHitUid, ...await callElement(command, hitId) };
        covered = (await call(targetId, `function(hit){
          const parent=node=>node.parentElement || node.getRootNode()?.host;
          for(let n=hit;n;n=parent(n)) if(n===this)return false;
          for(let n=this;n;n=parent(n)) if(n===hit)return false;
          return true;
        }`, [{ objectId: hitId }])).value === true;
      } catch { /* Cross-frame or detached hits remain unknown, not guessed. */ }
    }
    const sourceReason = obstructionReason(sourceFacts);
    const reason = normalized.details?.reason ?? (sourceReason && ['detached','disabled','inert'].includes(sourceReason) ? sourceReason : undefined)
      ?? obstructionReason(facts) ?? (covered ? 'covered' : 'unknown');
    throw new BrowserConnectorError(normalized.code, `${normalized.message}${attemptedPresses ? ' A click may have taken effect; observe before retrying.' : ' No click was sent.'}`, {
      ...normalized.details, uid, reason, targetState: facts, ...(sourceFacts !== facts ? { sourceState: sourceFacts } : {}), ...(occluder ? { hitElement: occluder } : {}),
      autoScrolled, mouseMoved, mouseMoveAttempted, stability, attemptedPresses, completedClicks, ...(hitTest ? { hitTest } : {}),
      inputDispatched: attemptedPresses ? 'possibly' : false, outcomeVerified: false,
      recovery: attemptedPresses
        ? 'Observe the page before retrying: input may already have taken effect.'
        : reason === 'layout_unavailable' ? 'The renderer did not supply usable layout. Keep the existing tab, inspect its rendering state and do not bring it forward automatically.'
        : 'Take a fresh snapshot and select the visible enabled control or its associated label. For custom controls or native dialogs, use Computer Use in the same authorized browser window; observe before acting.',
    });
  } finally {
    await Promise.all([...handles].map(objectId => command('Runtime.releaseObject', { objectId }).catch(() => {})));
  }
}
