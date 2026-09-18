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
const installPresentation = `(() => {
  window.__cardbushInlinePresentation?.dispose();
  let snapshot, fingerprint = '', waiter, pending = 0;
  const measure = () => {
    cancelAnimationFrame(pending);
    pending = 0;
    const body = document.body;
    if (!body) return;
    const style = getComputedStyle(body);
    // Absolutely positioned body children (including clipped live regions) can
    // overflow the root without contributing to body.scrollHeight. Measuring
    // their document-space bounds also lets the preview shrink after removal.
    const childBottom = [...body.children].reduce((bottom, child) =>
      getComputedStyle(child).position === 'fixed' ? bottom
        : Math.max(bottom, child.getBoundingClientRect().bottom + scrollY), 0);
    const bodyHeight = Math.max(body.scrollHeight, body.getBoundingClientRect().height)
      + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
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
  defaults.textContent = ':where(html){background:var(--background);color:var(--foreground);font-family:var(--font-sans)}:where(body){margin:0;background:transparent}'
    + 'html,body,body *{scrollbar-width:none!important;scrollbar-gutter:auto!important}'
    + '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
  document.head.append(defaults);
  window.__cardbushInlinePresentation = {
    read: previous => { measure(); return fingerprint !== previous ? Promise.resolve(snapshot) : new Promise(resolve => { waiter = resolve; }); },
    dispose: () => {
      resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(pending);
      removeEventListener('load', schedule, true); removeEventListener('resize', schedule);
      defaults.remove(); waiter?.(null); waiter = null;
    }
  };
})()`;

export function connectInlineHtmlPresentation(
  element: HTMLElement, host: Element, onLayout: (layout: InlineHtmlLayout) => void, onMode: (visualization: boolean) => void,
  onReady: () => void,
) {
  const guest = element as PreviewGuest;
  let disposed = false;
  let previousTheme = '';
  let started = false;
  let published = false;
  let pendingLayout: InlineHtmlLayout | undefined;
  let layoutTimer = 0, layoutDeadline = 0;
  const publishLayout = () => {
    window.clearTimeout(layoutTimer); window.clearTimeout(layoutDeadline);
    layoutTimer = 0; layoutDeadline = 0;
    if (disposed || !pendingLayout) return;
    // React batches mode, measured height and readiness into one commit. Never
    // reveal the old file viewport before discovering the chart's dimensions.
    onMode(true);
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
    if (!started || disposed) return;
    const script = themeScript();
    if (script) void guest.executeJavaScript(script).catch(() => {});
  };
  const themeObserver = new MutationObserver(updateTheme);
  // Appearance overrides may live on .app or its ancestor root.
  for (let ancestor: Element | null = appearance; ancestor; ancestor = ancestor.parentElement) {
    themeObserver.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  void (async () => {
    try {
      // Existing authored documents keep their own appearance and bounded file
      // preview. Only content designed for this host opts into chart embedding.
      const optedIn = await guest.executeJavaScript(`document.querySelector('meta[name="cardbush:preview"]')?.content === 'visualization'`);
      if (disposed) return;
      if (optedIn !== true) { onMode(false); onReady(); return; }
      await guest.executeJavaScript(themeScript() + ';' + installPresentation);
      if (disposed) return;
      started = true;
      updateTheme();
      let previous = '';
      while (!disposed) {
        const measured = await guest.executeJavaScript(`window.__cardbushInlinePresentation?.read(${JSON.stringify(previous)})`) as InlineHtmlLayout | undefined;
        if (disposed || !measured || !Number.isFinite(measured.height) || !Array.isArray(measured.blocks)) break;
        previous = JSON.stringify(measured);
        scheduleLayout(measured);
      }
    } catch { /* A loaded document can decline or lose its presentation bridge. */ }
    if (!disposed && !published) {
      // Keep an already measured layout, or use the bounded file viewport if
      // the bridge failed/returned no layout. Never leave a loaded file waiting.
      if (pendingLayout) publishLayout();
      else { onMode(false); onReady(); }
    }
  })();
  return () => {
    disposed = true;
    window.clearTimeout(layoutTimer); window.clearTimeout(layoutDeadline);
    themeObserver.disconnect();
    // Removing the webview disposes its observers and pending read with it.
  };
}
