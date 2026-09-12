import type { WindowScrollDiagnosticConfig } from '../../../electron/windowScrollDiagnostics';

type Detail = Record<string, unknown>;
const nodeIds = new WeakMap<Node, number>();
let nextNodeId = 0;
let nextTraceId = 0;
let currentRecorder: { active(): boolean; record(label: string, detail: Detail): void } | undefined;

export function windowScrollDiagnosticsActive() { return currentRecorder?.active() ?? false; }
export function recordWindowScrollDiagnostic(label: string, detail: Detail) { currentRecorder?.record(label, detail); }

function describe(node: Node | null): Detail | null {
  if (!node) return null;
  if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId);
  return node instanceof Element ? {
    nodeId: nodeIds.get(node), tag: node.tagName, classes: node.getAttribute('class')?.slice(0, 180),
    messageId: node.closest<HTMLElement>('[data-message-id]')?.dataset.messageId,
    connected: node.isConnected,
  } : { nodeId: nodeIds.get(node), type: node.nodeType, connected: node.isConnected };
}

function rect(value: DOMRectReadOnly) {
  const round = (n: number) => Math.round(n * 100) / 100;
  return { x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height) };
}

/** Diagnostics observe and forward scrolling; they never restore a position. */
export function observeWindowScrollDiagnostics(scroller: HTMLElement, readState: () => Detail) {
  let disposed = false;
  let stop: (() => void) | undefined;
  void window.cardbushDesktop?.windowScrollDiagnosticConfig?.().then(config => {
    if (!disposed && config && config.expiresAt > Date.now()) stop = install(scroller, readState, config);
  }).catch(() => undefined);
  return () => { disposed = true; stop?.(); };
}

function install(scroller: HTMLElement, readState: () => Detail, config: WindowScrollDiagnosticConfig) {
  const root = scroller.closest('.chat-panel') ?? scroller;
  const cleanups: Array<() => void> = [];
  let disposed = false, startedAt = 0, captureUntil = 0, timer = 0, frame = 0;
  let records: Detail[] = [], dropped = 0, traceId = '', previousGeometry = '';
  let anchors: HTMLElement[] = [];
  const active = () => !disposed && Date.now() < Math.min(captureUntil, config.expiresAt);
  const record = (label: string, detail: Detail = {}) => {
    if (!active()) return;
    if (records.length >= 240) { dropped++; return; }
    records.push({ at: new Date().toISOString(), t: Math.round(performance.now() * 100) / 100, label, ...detail });
  };
  const geometry = (node: Element | null) => node instanceof HTMLElement ? {
    ...describe(node), ...rect(node.getBoundingClientRect()),
    scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    scrollLeft: node.scrollLeft, clientWidth: node.clientWidth,
  } : null;
  const chooseAnchors = () => {
    anchors = [];
    const viewport = scroller.getBoundingClientRect();
    for (const item of scroller.querySelectorAll<HTMLElement>('.message-list-item')) {
      const bounds = item.getBoundingClientRect();
      if (bounds.bottom <= viewport.top) continue;
      if (bounds.top >= viewport.bottom) break;
      anchors.push(item);
      if (anchors.length === 3) break;
    }
  };
  const sample = (reason: string) => {
    if (!active()) return;
    const snapshot = {
      state: readState(), scroller: geometry(scroller),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        visualWidth: visualViewport?.width, visualHeight: visualViewport?.height,
        visualTop: visualViewport?.offsetTop, visualScale: visualViewport?.scale },
      document: { focused: document.hasFocus(), visibility: document.visibilityState,
        scrollTop: document.scrollingElement?.scrollTop, activeElement: describe(document.activeElement), fonts: document.fonts.status },
      panels: Object.fromEntries(['.app', '.main-stage', '.chat-panel', '.topbar', '.chat-body',
        '.chat-content-frame', '.message-list-content', '.message-list-footer', '.composer-dock', '.composer-surface']
        .map(selector => [selector, geometry(document.querySelector(selector))])),
      anchors: anchors.map(item => ({ ...geometry(item),
        contentVisibility: getComputedStyle(item).contentVisibility,
        intrinsicBlockSize: getComputedStyle(item).containIntrinsicBlockSize })),
      restoring: scroller.hasAttribute('data-scroll-restoring'), preserveScroll: scroller.dataset.cardbushPreserveScroll,
    };
    const signature = JSON.stringify({ ...snapshot, state: { ...snapshot.state,
      manualDetachRemainingMs: undefined, programmaticRemainingMs: undefined } });
    if (signature !== previousGeometry) { previousGeometry = signature; record('geometry', { reason, ...snapshot }); }
  };
  const resize = new ResizeObserver(entries => record('resize-observer', {
    entries: entries.slice(0, 16).map(entry => ({ target: describe(entry.target), ...rect(entry.contentRect) })),
  }));
  const mutation = new MutationObserver(entries => record('dom-mutation', {
    count: entries.length,
    entries: entries.slice(0, 12).map(entry => ({ type: entry.type, target: describe(entry.target), attribute: entry.attributeName,
      added: [...entry.addedNodes].slice(0, 4).map(describe), removed: [...entry.removedNodes].slice(0, 4).map(describe) })),
  }));
  const shifts = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('layout-shift')
    ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean;
          sources: Array<{ node: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
        record('layout-shift', { value: shift.value, hadRecentInput: shift.hadRecentInput,
          sources: shift.sources.slice(0, 8).map(source => ({ node: describe(source.node),
            before: rect(source.previousRect), after: rect(source.currentRect) })) });
      }
    }) : undefined;
  const flush = (reason: string) => {
    cancelAnimationFrame(frame); frame = 0; clearTimeout(timer); timer = 0;
    resize.disconnect(); mutation.disconnect(); shifts?.disconnect();
    if (records.length) {
      const payload = { source: 'renderer', runId: config.runId, traceId, reason, dropped, records };
      void window.cardbushDesktop?.writeDebugLog?.('window-scroll', payload).catch(() => undefined);
    }
    records = []; dropped = 0; captureUntil = 0;
  };
  const tick = () => {
    frame = 0;
    if (!active()) { flush('capture-complete'); return; }
    sample('animation-frame'); frame = requestAnimationFrame(tick);
  };
  const start = (reason: string, detail: Detail = {}) => {
    if (disposed || Date.now() >= config.expiresAt) return;
    const now = Date.now();
    if (!active()) {
      if (records.length) flush('next-capture');
      startedAt = now; previousGeometry = ''; traceId = `${config.runId}:${++nextTraceId}`;
      chooseAnchors();
      for (const selector of ['.chat-panel', '.chat-body', '.message-list', '.message-list-content', '.message-list-footer', '.composer-dock']) {
        const node = root.matches(selector) ? root : root.querySelector(selector);
        if (node) resize.observe(node);
      }
      mutation.observe(root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'data-scroll-restoring', 'data-cardbush-preserve-scroll'] });
      shifts?.observe({ type: 'layout-shift' });
    }
    captureUntil = Math.min(config.expiresAt, startedAt + 5000, now + 1800);
    record(reason, detail); sample(reason);
    if (!frame) frame = requestAnimationFrame(tick);
    clearTimeout(timer); timer = window.setTimeout(() => flush('capture-timeout'), captureUntil - now + 20);
  };
  const listen = (target: EventTarget, name: string, callback: EventListener, capture = false) => {
    target.addEventListener(name, callback, { capture, passive: true });
    cleanups.push(() => target.removeEventListener(name, callback, capture));
  };
  for (const name of ['focus', 'blur', 'pageshow', 'resize']) listen(window, name, () => start(`window:${name}`));
  listen(document, 'visibilitychange', () => start('document:visibilitychange'));
  for (const name of ['focusin', 'focusout', 'scroll', 'pointerdown', 'wheel', 'keydown', 'contentvisibilityautostatechange']) {
    listen(document, name, event => {
      if (!active()) return;
      const wheel = event instanceof WheelEvent ? { deltaX: event.deltaX, deltaY: event.deltaY } : {};
      record(`dom:${name}`, { target: describe(event.target instanceof Node ? event.target : null),
        trusted: event.isTrusted, ...wheel,
        skipped: (event as Event & { skipped?: boolean }).skipped,
        ...(name.startsWith('focus') ? { stack: new Error().stack?.split('\n').slice(2, 9).join('\n') } : {}),
      });
    }, true);
  }
  const unsubscribe = window.cardbushDesktop?.onWindowScrollDiagnosticEvent?.(event => start(`native:${event.event}`, { nativeAt: event.at }));
  if (unsubscribe) cleanups.push(unsubscribe);

  // Intercept only this scroller, forward native arguments unchanged, and
  // restore every descriptor on disposal. Browser-driven scrolls bypass these
  // JS calls and appear as scroll/geometry events without a programmatic cause.
  for (const name of ['scrollTo', 'scrollBy', 'scroll'] as const) {
    const own = Object.getOwnPropertyDescriptor(scroller, name), method = scroller[name];
    const wrapped = function(this: HTMLElement, ...args: unknown[]) {
      if (active()) record('js-scroll', { method: name, args, before: this.scrollTop,
        stack: new Error().stack?.split('\n').slice(2, 9).join('\n') });
      return Reflect.apply(method, this, args);
    };
    Object.defineProperty(scroller, name, { configurable: true, writable: true, value: wrapped });
    cleanups.push(() => {
      if (scroller[name] !== wrapped) return;
      if (own) Object.defineProperty(scroller, name, own); else Reflect.deleteProperty(scroller, name);
    });
  }
  const ownTop = Object.getOwnPropertyDescriptor(scroller, 'scrollTop');
  let prototype: object | null = scroller;
  let nativeTop: PropertyDescriptor | undefined;
  while (prototype && !nativeTop) { nativeTop = Object.getOwnPropertyDescriptor(prototype, 'scrollTop'); prototype = Object.getPrototypeOf(prototype); }
  if (nativeTop?.get && nativeTop.set) {
    const descriptor = nativeTop;
    const setter = function(this: HTMLElement, value: number) {
      if (active()) record('js-scroll', { method: 'scrollTop', target: value, before: descriptor.get!.call(this),
        stack: new Error().stack?.split('\n').slice(2, 9).join('\n') });
      descriptor.set!.call(this, value);
    };
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: descriptor.get, set: setter });
    cleanups.push(() => {
      if (Object.getOwnPropertyDescriptor(scroller, 'scrollTop')?.set !== setter) return;
      if (ownTop) Object.defineProperty(scroller, 'scrollTop', ownTop); else Reflect.deleteProperty(scroller, 'scrollTop');
    });
  }
  const recorder = { active, record }; currentRecorder = recorder;
  const stop = () => {
    record('scroller-detached', { scroller: describe(scroller), state: readState() });
    flush('observer-disposed'); disposed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    if (currentRecorder === recorder) currentRecorder = undefined;
  };
  const expiry = window.setTimeout(stop, config.expiresAt - Date.now());
  cleanups.push(() => clearTimeout(expiry));
  start('scroller-attached', { scroller: describe(scroller), expiresAt: config.expiresAt });
  return stop;
}
