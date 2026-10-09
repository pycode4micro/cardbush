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
  const payload = { version: 1, dropped, records };
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
  };
}

/** Bounded, batched diagnostics; never mutate scrolling, layout or guest state. */
export function observeInlineHtmlDiagnostics(
  host: HTMLElement, path: string, readState: () => Detail,
): InlineHtmlDiagnostics | undefined {
  if (!window.cardbushDesktop?.writeDebugLog) return;
  activeRecorders++;
  const previewId = ++nextPreview, key = fileKey(path);
  let disposed = false, lastScroll = 0, settledTimer = 0, lastGeometry = '';
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
    for (let ancestor = skipped ? item as HTMLElement : host.parentElement; ancestor && ancestors.length < 8; ancestor = ancestor.parentElement) {
      ancestors.push({ role: ancestor === item ? 'message' : ancestor === scroller ? 'scroller' : ancestor.tagName.toLowerCase(), ...geometry(ancestor) });
      if (ancestor === scroller) break;
    }
    const state = readState();
    const current = {
      state, guestId, skipped, host: skipped ? null : geometry(host), viewport: skipped ? null : geometry(host.querySelector('.inline-html-viewport')),
      frame: skipped ? null : geometry(frame), ancestors,
      scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
      window: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState },
    };
    const signature = JSON.stringify(current);
    if (event === 'scroll-sample' && signature === lastGeometry) return;
    lastGeometry = signature;
    record(event, { ...current, ...detail });
  };
  const scroll = () => {
    if (!readState().visible) return;
    const now = performance.now();
    if (now - lastScroll >= 200) { lastScroll = now; snapshot('scroll-sample'); }
    clearTimeout(settledTimer);
    settledTimer = window.setTimeout(() => snapshot('scroll-settled'), 200);
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
      resize.disconnect(); mutation.disconnect(); clearTimeout(settledTimer);
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
    if (!message?.startsWith(guestPrefix) || message.length > 1024) return;
    try {
      const value = JSON.parse(message.slice(guestPrefix.length));
      if (!['scroll', 'wheel', 'resize', 'frame-gap', 'visibility'].includes(value.event)) return;
      const metrics: Detail = { kind: value.event };
      for (const key of ['x', 'y', 'width', 'height', 'bodyHeight', 'documentHeight', 'gapMs', 'deltaY']) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key])) metrics[key] = value[key];
      }
      if (typeof value.hidden === 'boolean') metrics.hidden = value.hidden;
      diagnostic.record('guest-metrics', metrics);
    } catch { /* Authored console output is untrusted; accept metrics only. */ }
  };
  guest.addEventListener('console-message', receive);
  void guest.executeJavaScript(`(() => {
    window.__cardbushHtmlDiagnostic?.dispose();
    let last = 0, frame = 0, previous = 0, until = 0;
    const send = (event, detail = {}) => console.info(${JSON.stringify(guestPrefix)} + JSON.stringify({event,
      x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,bodyHeight:document.body?.scrollHeight,
      documentHeight:document.documentElement.scrollHeight,hidden:document.hidden,...detail}));
    const tick = time => {
      frame = 0;
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
    window.__cardbushHtmlDiagnostic={dispose:()=>{
      resize.disconnect();cancelAnimationFrame(frame);removeEventListener('scroll',sample,true);
      removeEventListener('wheel',sample);removeEventListener('resize',sample);document.removeEventListener('visibilitychange',visibility);
    }};
  })()`).catch(() => diagnostic.record('guest-diagnostic-unavailable'));
  return () => guest.removeEventListener('console-message', receive);
}
