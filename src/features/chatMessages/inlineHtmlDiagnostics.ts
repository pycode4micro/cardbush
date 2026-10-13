type Detail = Record<string, unknown>;
export type InlineHtmlDiagnostics = { record(event: string, detail?: Detail): void; dispose(): void };
const guestPrefix = '[cardbush:inline-html-metrics]';

const nodes = new WeakMap<Element, number>();
let nextNode = 0, nextPreview = 0, activeRecorders = 0;
let records: Detail[] = [], dropped = 0, flushTimer = 0;

// Correlate duplicate references without logging paths, titles or document text.
function fileKey(path: string) {
  let hash = 2166136261;
  for (const char of path.replaceAll('\\', '/')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

function flush() {
  clearTimeout(flushTimer); flushTimer = 0;
  if (!records.length) return;
  const payload = { version: 2, dropped, records };
  records = []; dropped = 0;
  void window.cardbushDesktop?.writeDebugLog?.('inline-html-preview', payload).catch(() => undefined);
}

function enqueue(record: Detail) {
  if (records.length < 160) records.push(record); else dropped++;
  if (!flushTimer) flushTimer = window.setTimeout(flush, 1000);
}

function geometry(element: Element | null) {
  if (!element) return null;
  if (!nodes.has(element)) nodes.set(element, ++nextNode);
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    nodeId: nodes.get(element), connected: element.isConnected,
    x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
    display: style.display, visibility: style.visibility, opacity: style.opacity,
    contentVisibility: style.contentVisibility, contain: style.contain,
    transform: style.transform, clipPath: style.clipPath, animation: style.animationName,
    overflowX: style.overflowX, overflowY: style.overflowY, mask: style.maskImage !== 'none',
    filter: style.filter !== 'none', backdropFilter: style.backdropFilter !== 'none', willChange: style.willChange,
  };
}

/** Visible pixels in guest coordinates, including the host's clipping ancestors. */
function visibleGuestRegion(frame: Element, host: HTMLElement) {
  const bounds = frame.getBoundingClientRect();
  let left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
  let right = Math.min(innerWidth, bounds.right), bottom = Math.min(innerHeight, bounds.bottom);
  for (let ancestor = frame.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
    if (style.overflowX !== 'visible') { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    if (style.overflowY !== 'visible') { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
  }
  const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
  const hits = width && height ? [0.1, 0.5, 0.9].map(fraction => {
    const hit = document.elementFromPoint(left + width / 2, top + height * fraction);
    return hit === frame ? 'guest' : !hit ? 'none' : host.contains(hit) ? 'preview-overlay' : 'outside-overlay';
  }) : [];
  return { left: Math.round(left - bounds.left), top: Math.round(top - bounds.top),
    width: Math.round(width), height: Math.round(height), hits };
}

/** Bounded, batched diagnostics; never mutate scrolling, layout or guest state. */
export function observeInlineHtmlDiagnostics(
  host: HTMLElement, path: string, readState: () => Detail,
): InlineHtmlDiagnostics | undefined {
  if (!window.cardbushDesktop?.writeDebugLog) return;
  activeRecorders++;
  const previewId = ++nextPreview, key = fileKey(path);
  let disposed = false, lastScroll = 0, settledTimer = 0, lastGeometry = '';
  let frameMonitor = 0, framesUntil = 0, framesStarted = 0, previousFrame = 0, frameCount = 0, maxFrameGap = 0;
  let lastGuestProbe = 0, guestProbePending = false;
  let scroller = host.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const item = host.closest('.message-list-item');
  const record = (event: string, detail: Detail = {}) => {
    if (disposed) return;
    enqueue({ at: new Date().toISOString(), t: Math.round(performance.now()), previewId, fileKey: key, event, ...detail });
  };
  const snapshot = (event: string, detail: Detail = {}) => {
    if (disposed) return;
    const frame = host.querySelector('webview') as (HTMLElement & { getWebContentsId(): number }) | null;
    let guestId: number | undefined;
    try { guestId = frame?.getWebContentsId(); } catch { /* Guest may not have attached yet. */ }
    // Reading descendant rectangles inside a skipped row forces Chromium to
    // lay it out, which would mask the bug these diagnostics are observing.
    const skipped = item ? !host.checkVisibility({ contentVisibilityAuto: true }) : false;
    const ancestors = [];
    for (let ancestor = skipped ? item as HTMLElement : host.parentElement; ancestor && ancestors.length < 12; ancestor = ancestor.parentElement) {
      ancestors.push({ role: ancestor === item ? 'message' : ancestor === scroller ? 'scroller' : ancestor.tagName.toLowerCase(), ...geometry(ancestor) });
      if (ancestor === scroller) break;
    }
    const state = readState();
    const current = {
      state, guestId, skipped, host: skipped ? null : geometry(host), viewport: skipped ? null : geometry(host.querySelector('.inline-html-viewport')),
      frame: skipped ? null : geometry(frame), ancestors,
      region: skipped || !frame ? null : visibleGuestRegion(frame, host),
      scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
      window: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState },
    };
    const signature = JSON.stringify(current);
    if (event === 'scroll-sample' && signature === lastGeometry) return;
    lastGeometry = signature;
    record(event, { ...current, ...detail });
  };
  const monitorFrames = () => {
    const now = performance.now();
    framesUntil = now + 350;
    if (frameMonitor) return;
    framesStarted = previousFrame = now; frameCount = maxFrameGap = 0;
    const tick = (time: number) => {
      frameMonitor = 0;
      if (disposed || document.hidden || !readState().visible) return;
      maxFrameGap = Math.max(maxFrameGap, time - previousFrame); previousFrame = time; frameCount++;
      if (time < framesUntil && time - framesStarted < 1500) frameMonitor = requestAnimationFrame(tick);
      else snapshot('host-frames', { frames: frameCount, durationMs: Math.round(time - framesStarted), maxGapMs: Math.round(maxFrameGap) });
    };
    frameMonitor = requestAnimationFrame(tick);
  };
  const probeGuest = () => {
    const now = performance.now();
    if (guestProbePending || now - lastGuestProbe < 500 || readState().state !== 'ready') return;
    const guest = host.querySelector('webview') as (HTMLElement & { executeJavaScript(code: string): Promise<unknown> }) | null;
    if (!guest || !host.checkVisibility({ contentVisibilityAuto: true })) return;
    const region = visibleGuestRegion(guest, host);
    if (!region.width || !region.height) return;
    lastGuestProbe = now; guestProbePending = true;
    // Only sample the currently exposed band of a long document. No contents,
    // screenshots or user input cross this boundary.
    void guest.executeJavaScript(`window.__cardbushHtmlDiagnostic?.sample(${JSON.stringify(region)})`)
      .catch(() => undefined).finally(() => { guestProbePending = false; });
  };
  const scroll = () => {
    if (!readState().visible) return;
    monitorFrames();
    const now = performance.now();
    if (now - lastScroll >= 200) { lastScroll = now; snapshot('scroll-sample'); probeGuest(); }
    clearTimeout(settledTimer);
    settledTimer = window.setTimeout(() => { snapshot('scroll-settled'); probeGuest(); }, 200);
  };
  const skip = (event: Event) => snapshot('content-visibility', { skipped: (event as Event & { skipped: boolean }).skipped });
  const resize = new ResizeObserver(entries => snapshot('host-resize', {
    sizes: entries.map(entry => ({ width: entry.contentRect.width, height: entry.contentRect.height })),
  }));
  resize.observe(host);
  const mutation = new MutationObserver(entries => {
    const added = entries.flatMap(entry => [...entry.addedNodes]).filter(node => node instanceof Element && (node.matches('webview') || node.querySelector('webview'))).length;
    const removed = entries.flatMap(entry => [...entry.removedNodes]).filter(node => node instanceof Element && (node.matches('webview') || node.querySelector('webview'))).length;
    if (added || removed) snapshot('guest-dom', { added, removed });
  });
  mutation.observe(host, { childList: true, subtree: true });
  scroller?.addEventListener('scroll', scroll, { passive: true });
  item?.addEventListener('contentvisibilityautostatechange', skip);
  snapshot('mount');
  return {
    record: (event, detail) => snapshot(event, detail),
    dispose: () => {
      if (disposed) return;
      snapshot('unmount'); disposed = true;
      resize.disconnect(); mutation.disconnect(); clearTimeout(settledTimer); cancelAnimationFrame(frameMonitor);
      scroller?.removeEventListener('scroll', scroll);
      item?.removeEventListener('contentvisibilityautostatechange', skip);
      // Switching a long conversation disposes many previews in one commit.
      // Persist that batch once, rather than one synchronous main-process write
      // for every row. Any remaining previews share the ordinary flush timer.
      if (--activeRecorders === 0) flush();
    },
  };
}

// Guest scrolling does not bubble into the host document. Send only numeric
// presentation metrics through webview's console event, without exposing IPC.
export function connectInlineHtmlGuestDiagnostics(
  guest: HTMLElement & { executeJavaScript(code: string): Promise<unknown> }, diagnostic: InlineHtmlDiagnostics,
) {
  const receive = (event: Event) => {
    const message = (event as Event & { message?: string }).message;
    if (!message?.startsWith(guestPrefix) || message.length > 4096) return;
    try {
      const value = JSON.parse(message.slice(guestPrefix.length));
      if (!['scroll', 'wheel', 'resize', 'frame-gap', 'visibility', 'activity', 'region'].includes(value.event)) return;
      const metrics: Detail = { kind: value.event };
      for (const key of ['x', 'y', 'width', 'height', 'bodyHeight', 'documentHeight', 'gapMs', 'deltaY',
        'mutations', 'svgMutations', 'tableMutations', 'canvasResizes', 'longTasks', 'longTaskMs', 'layoutShifts', 'layoutShiftScore']) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key])) metrics[key] = value[key];
      }
      if (typeof value.hidden === 'boolean') metrics.hidden = value.hidden;
      if (Array.isArray(value.regions)) metrics.regions = value.regions.slice(0, 16).flatMap((region: Record<string, unknown> | null) => {
        if (!region || !['SECTION', 'TABLE', 'SVG', 'CANVAS'].includes(String(region.tag))) return [];
        const result: Detail = { tag: region.tag };
        for (const key of ['index', 'top', 'bottom', 'width', 'height', 'opacity']) {
          if (typeof region[key] === 'number' && Number.isFinite(region[key])) result[key] = region[key];
        }
        if (typeof region.visible === 'boolean') result.visible = region.visible;
        return [result];
      });
      diagnostic.record('guest-metrics', metrics);
    } catch { /* Authored console output is untrusted; accept metrics only. */ }
  };
  guest.addEventListener('console-message', receive);
  void guest.executeJavaScript(`(() => {
    window.__cardbushHtmlDiagnostic?.dispose();
    let last = 0, frame = 0, previous = 0, until = 0, activityTimer = 0;
    const emptyActivity = () => ({mutations:0,svgMutations:0,tableMutations:0,canvasResizes:0,
      longTasks:0,longTaskMs:0,layoutShifts:0,layoutShiftScore:0});
    let activity = emptyActivity();
    const send = (event, detail = {}) => console.info(${JSON.stringify(guestPrefix)} + JSON.stringify({event,
      x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,bodyHeight:document.body?.scrollHeight,
      documentHeight:document.documentElement.scrollHeight,hidden:document.hidden,...detail}));
    const flushActivity = () => {
      clearTimeout(activityTimer); activityTimer = 0;
      if (Object.values(activity).some(Boolean)) send('activity',activity);
      activity = emptyActivity();
    };
    const queueActivity = () => { if (!activityTimer) activityTimer = setTimeout(flushActivity,1000); };
    const mutation = new MutationObserver(records => {
      activity.mutations += records.length;
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        if (element?.closest('svg')) activity.svgMutations++;
        if (element?.closest('table')) activity.tableMutations++;
        if (element?.tagName==='CANVAS' && ['width','height'].includes(record.attributeName)) activity.canvasResizes++;
      }
      queueActivity();
    });
    mutation.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    const performanceObservers = [];
    for (const type of ['longtask','layout-shift']) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (type==='longtask') {activity.longTasks++;activity.longTaskMs+=Math.round(entry.duration);}
          else {activity.layoutShifts++;activity.layoutShiftScore+=entry.value;}
        }
        queueActivity();
      });
      observer.observe({type});performanceObservers.push(observer);
    }
    const sampleRegion = region => {
      flushActivity();
      const regions = [];
      for (const [index,element] of [...document.querySelectorAll('section,table,svg,canvas')].slice(0,64).entries()) {
        const rect=element.getBoundingClientRect();
        if (rect.bottom<=region.top || rect.top>=region.top+region.height || rect.width<40 || rect.height<20) continue;
        regions.push({index,tag:element.tagName.toUpperCase(),top:Math.round(rect.top),bottom:Math.round(rect.bottom),
          width:Math.round(rect.width),height:Math.round(rect.height),opacity:Number(getComputedStyle(element).opacity),
          visible:element.checkVisibility({contentVisibilityAuto:true,opacityProperty:true,visibilityProperty:true})});
        if (regions.length===16) break;
      }
      send('region',{regions});
    };
    const tick = time => {
      frame = 0;
      if (document.hidden) {previous=0;return;}
      if (previous && time - previous > 80) send('frame-gap',{gapMs:Math.round(time-previous)});
      previous = time;
      if (time < until) frame = requestAnimationFrame(tick); else previous = 0;
    };
    const sample = event => {
      const now = performance.now(); until = now + 350;
      if (!frame) {previous=0;frame=requestAnimationFrame(tick);}
      if (now-last < 200) return;
      last=now;send(event.type,{deltaY:event.deltaY});
    };
    const resize = new ResizeObserver(()=>{const now=performance.now();if(now-last>=200){last=now;send('resize');}});
    const visibility = () => send('visibility');
    resize.observe(document.body);
    addEventListener('scroll',sample,{capture:true,passive:true});addEventListener('wheel',sample,{passive:true});
    addEventListener('resize',sample);document.addEventListener('visibilitychange',visibility);
    window.__cardbushHtmlDiagnostic={sample:sampleRegion,dispose:()=>{
      resize.disconnect();mutation.disconnect();performanceObservers.forEach(observer=>observer.disconnect());
      clearTimeout(activityTimer);cancelAnimationFrame(frame);removeEventListener('scroll',sample,true);
      removeEventListener('wheel',sample);removeEventListener('resize',sample);document.removeEventListener('visibilitychange',visibility);
    }};
  })()`).catch(() => diagnostic.record('guest-diagnostic-unavailable'));
  return () => guest.removeEventListener('console-message', receive);
}
