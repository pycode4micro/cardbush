import { connectInlineHtmlScrolling } from './inlineHtmlScrolling';

type PreviewGuest = HTMLElement & { executeJavaScript(code: string): Promise<unknown> };
export type InlineHtmlLayout = { height: number; blocks: Array<{ top: number; bottom: number }> };

export function foldedHtmlHeight(layout: InlineHtmlLayout, limit: number) {
  // Prefer the last complete chart row that fits, without cutting a neighbouring
  // chart in a grid. A single oversized plot still gets the ordinary height cap.
  const minimum = Math.min(180, limit * 0.5);
  const ends = layout.blocks.map(block => Math.ceil(block.bottom)).filter(end => end >= minimum && end <= limit &&
    !layout.blocks.some(block => block.top < end - 1 && block.bottom > end + 1));
  return ends.length ? Math.max(...ends) : limit;
}

// This bridge exposes presentation data only. The guest retains its sandbox and
// never receives IPC, filesystem access, credentials, or conversation context.
const installPresentation = (themed: boolean) => `(() => {
  window.__cardbushInlinePresentation?.dispose();
  let snapshot, fingerprint = '', waiter, pending = 0;
  let previousSizing;
  const sizingOverrides = [];
  const rootSizing = () => ({ width: innerWidth, height: innerHeight, roots: [document.documentElement, document.body].map(element => ({
    element, signature: element.getAttribute('style') + '|' + element.className,
    values: Object.fromEntries(['height','min-height','max-height'].map(property =>
      [property, element.computedStyleMap().get(property)?.toString()]))
  })) });
  const stabilizeRootSizing = () => {
    const next = rootSizing();
    // An intrinsic-height guest must not feed its new height back through an
    // authored root 100vh/min-height plus padding, growing forever. Pin only
    // resolved root lengths that changed with a host height resize. Keep auto
    // sizing, authored style/class edits and width-responsive layouts live.
    if (previousSizing && next.width === previousSizing.width && next.height !== previousSizing.height) {
      next.roots.forEach((root, index) => {
        const previous = previousSizing.roots[index];
        if (root.signature !== previous.signature) return;
        for (const [property, value] of Object.entries(root.values)) {
          const before = previous.values[property];
          if (value === before || !String(value).endsWith('px') || !String(before).endsWith('px')) continue;
          sizingOverrides.push({ element: root.element, property, value: before,
            original: root.element.style.getPropertyValue(property), priority: root.element.style.getPropertyPriority(property) });
          root.element.style.setProperty(property, before, 'important');
        }
      });
    }
    previousSizing = rootSizing();
  };
  const measure = () => {
    cancelAnimationFrame(pending);
    pending = 0;
    const body = document.body;
    if (!body) return;
    stabilizeRootSizing();
    const style = getComputedStyle(body);
    // Absolutely positioned body children (including clipped live regions) can
    // overflow the root without contributing to body.scrollHeight. Measuring
    // their document-space bounds also lets the preview shrink after removal.
    const childBottom = [...body.children].reduce((bottom, child) => {
      const childStyle = getComputedStyle(child);
      // A last child's collapsed margin can extend the document past the body.
      // Include it or an otherwise full-height embed gains a tiny inner scroll.
      return childStyle.position === 'fixed' ? bottom : Math.max(bottom,
        child.getBoundingClientRect().bottom + scrollY + (parseFloat(childStyle.marginBottom) || 0));
    }, 0);
    const bodyBounds = body.getBoundingClientRect();
    // The first child's margin can collapse through body too. Use the actual
    // document-space top, not just body's declared margin, to avoid a hidden
    // root offset in ordinary HTML (for example, its default <p> margins).
    const bodyHeight = bodyBounds.top + scrollY + Math.max(body.scrollHeight, bodyBounds.height)
      + (parseFloat(style.marginBottom) || 0);
    const height = Math.max(120, Math.ceil(Math.max(bodyHeight, childBottom)));
    const blocks = [];
    const seen = new Set();
    for (const plot of [...body.querySelectorAll('svg,canvas,[data-chart-section]')].slice(0,256)) {
      const block = plot.closest('[data-chart-section]') || plot.closest('figure,section') || plot;
      if (seen.has(block)) continue;
      seen.add(block);
      const rect = block.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40 || getComputedStyle(block).position === 'fixed') continue;
      blocks.push({ top: Math.floor(rect.top + scrollY), bottom: Math.ceil(rect.bottom + scrollY) });
    }
    const next = {height, blocks};
    const key = JSON.stringify(next);
    if (key === fingerprint) return;
    snapshot = next; fingerprint = key;
    const resolve = waiter; waiter = null; resolve?.(snapshot);
  };
  const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const mutation = new MutationObserver(records => {
    // Moving a crosshair or fading a series does not change layout. Avoid
    // measuring every SVG point on each animation or pointer event.
    if (records.some(record => record.type !== 'attributes' || !(record.target instanceof SVGElement) || record.target.tagName === 'svg')) schedule();
  });
  resize.observe(document.body);
  mutation.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  addEventListener('load', schedule, true);
  addEventListener('resize', schedule);
  document.fonts.ready.then(schedule);
  const defaults = document.createElement('style');
  defaults.textContent = ${JSON.stringify(themed ? ':where(html){background:var(--background);color:var(--foreground);font-family:var(--font-sans)}:where(body){margin:0;background:transparent}'
    + ':where(body *){scrollbar-width:thin;scrollbar-color:var(--muted-foreground) transparent}' : '')};
  document.head.append(defaults);
  window.__cardbushInlinePresentation = {
    read: previous => { measure(); return fingerprint !== previous ? Promise.resolve(snapshot) : new Promise(resolve => { waiter = resolve; }); },
    dispose: () => {
      resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(pending);
      removeEventListener('load', schedule, true); removeEventListener('resize', schedule);
      for (const override of sizingOverrides.reverse()) {
        if (override.element.style.getPropertyValue(override.property) === override.value)
          override.element.style.setProperty(override.property, override.original, override.priority);
      }
      defaults.remove(); waiter?.(null); waiter = null;
    }
  };
})()`;

export function connectInlineHtmlPresentation(
  element: HTMLElement, host: Element, onLayout: (layout: InlineHtmlLayout) => void, onMode: (visualization: boolean) => void,
  onReady: () => void,
  diagnostic?: (event: string, detail: Record<string, unknown>) => void,
) {
  const guest = element as PreviewGuest;
  let disposed = false;
  let previousTheme = '';
  let started = false;
  let visualization = false;
  let disconnectScrolling: (() => void) | undefined;
  let published = false;
  let pendingLayout: InlineHtmlLayout | undefined;
  let layoutTimer = 0, layoutDeadline = 0;
  const publishLayout = () => {
    window.clearTimeout(layoutTimer); window.clearTimeout(layoutDeadline);
    layoutTimer = 0; layoutDeadline = 0;
    if (disposed || !pendingLayout) return;
    // React batches mode, measured height and readiness into one commit. Never
    // reveal the old file viewport before discovering the chart's dimensions.
    onMode(visualization);
    diagnostic?.('layout-published', { height: pendingLayout.height, blocks: pendingLayout.blocks.length, first: !published });
    onLayout(pendingLayout);
    pendingLayout = undefined;
    if (!published) { published = true; onReady(); }
  };
  const scheduleLayout = (layout: InlineHtmlLayout) => {
    pendingLayout = layout;
    window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(publishLayout, 80);
    if (!layoutDeadline) layoutDeadline = window.setTimeout(publishLayout, 250);
  };
  const appearance = host.closest('.app') ?? document.documentElement;
  const themeScript = () => {
    const style = getComputedStyle(appearance);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const theme = style.colorScheme.split(' ').includes('dark') ? 'dark' : 'light';
    let background = color('--bg');
    for (let ancestor: Element | null = host; ancestor; ancestor = ancestor.parentElement) {
      const candidate = getComputedStyle(ancestor).backgroundColor;
      if (candidate !== 'transparent' && candidate !== 'rgba(0, 0, 0, 0)') { background = candidate; break; }
    }
    const tokens = {
      '--background': background, '--foreground': color('--text'),
      '--muted-foreground': color('--text-mid'), '--border': color('--border'),
      '--popover': color('--surface-raised'), '--popover-foreground': color('--text'),
      '--primary': color('--action'), '--primary-foreground': color('--on-action'),
      '--font-sans': style.fontFamily,
      '--viz-series-1': theme === 'dark' ? '#6aa9ff' : '#2468c4',
      '--viz-series-2': theme === 'dark' ? '#f6b36b' : '#b45b08',
      '--viz-series-3': theme === 'dark' ? '#73c9a2' : '#247b56',
      '--viz-series-4': theme === 'dark' ? '#c2a3ee' : '#8150b6',
      '--viz-series-5': theme === 'dark' ? '#ee91a6' : '#b94267',
      '--viz-series-6': theme === 'dark' ? '#70c9d6' : '#247d8c',
    };
    const serialized = JSON.stringify({ theme, tokens });
    if (serialized === previousTheme) return '';
    previousTheme = serialized;
    (host as HTMLElement).style.setProperty('--inline-html-background', background);
    return `(() => {
      const context = ${serialized};
      const root = document.documentElement;
      root.style.colorScheme = context.theme;
      root.dataset.cardbushTheme = context.theme;
      for (const [name, value] of Object.entries(context.tokens)) root.style.setProperty(name, value);
      dispatchEvent(new CustomEvent('cardbush:theme-change', { detail: context }));
    })()`;
  };
  const updateTheme = () => {
    if (!started || disposed || !visualization) return;
    const script = themeScript();
    if (script) { diagnostic?.('theme-updated', {}); void guest.executeJavaScript(script).catch(() => {}); }
  };
  const themeObserver = new MutationObserver(updateTheme);
  // Appearance overrides may live on .app or its ancestor root.
  for (let ancestor: Element | null = appearance; ancestor; ancestor = ancestor.parentElement) {
    themeObserver.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  void (async () => {
    try {
      // Every inline document joins the conversation's scroll flow. Opting into
      // visualization changes appearance, never scrolling or height ownership.
      const optedIn = await guest.executeJavaScript(`document.querySelector('meta[name="cardbush:preview"]')?.content === 'visualization'`);
      if (disposed) return;
      disconnectScrolling = connectInlineHtmlScrolling(guest, host, diagnostic);
      visualization = optedIn === true;
      diagnostic?.('presentation-mode', { visualization });
      await guest.executeJavaScript((visualization ? themeScript() : '') + ';' + installPresentation(visualization));
      if (disposed) return;
      diagnostic?.('presentation-installed', { version: 4 });
      started = true;
      updateTheme();
      let previous = '';
      while (!disposed) {
        const measured = await guest.executeJavaScript(`window.__cardbushInlinePresentation?.read(${JSON.stringify(previous)})`) as InlineHtmlLayout | undefined;
        if (disposed || !measured || !Number.isFinite(measured.height) || !Array.isArray(measured.blocks)) break;
        previous = JSON.stringify(measured);
        diagnostic?.('layout-measured', { height: measured.height, blocks: measured.blocks.length });
        scheduleLayout(measured);
      }
    } catch { diagnostic?.('presentation-bridge-error', {}); }
    if (!disposed && !published) {
      // Keep an already measured layout, or use the bounded file viewport if
      // the bridge failed/returned no layout. Never leave a loaded file waiting.
      if (pendingLayout) publishLayout();
      else { onMode(false); onReady(); }
    }
  })();
  return () => {
    disposed = true;
    disconnectScrolling?.();
    window.clearTimeout(layoutTimer); window.clearTimeout(layoutDeadline);
    themeObserver.disconnect();
    // Removing the webview disposes its observers and pending read with it.
  };
}
