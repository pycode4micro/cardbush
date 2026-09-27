const managedTitle = 'data-global-tooltip-title';
type TitleEntry = { text: string; label?: string; description?: string };

/** Own native titles for the lifetime of the tooltip host, not just a hover.
 * An empty title blocks inherited native help and still lets React remove or
 * replace the attribute when its source prop changes. */
export function observeNativeTooltipTitles(onChange: () => void) {
  const entries = new Map<Element, TitleEntry>();
  const selector = `[${managedTitle}]`;
  function releaseAria(element: Element, entry: TitleEntry) {
    if (entry.label !== undefined && element.getAttribute('aria-label') === entry.label) element.removeAttribute('aria-label');
    if (entry.description !== undefined && element.getAttribute('aria-description') === entry.description) element.removeAttribute('aria-description');
  }
  function release(element: Element) {
    const entry = entries.get(element);
    if (!entry) return;
    if (element.getAttribute('title') === '') element.setAttribute('title', entry.text);
    releaseAria(element, entry);
    element.removeAttribute(managedTitle);
    entries.delete(element);
  }
  function capture(element: Element, updated = false) {
    // Frame titles name embedded documents; their contents own their UI.
    if (element.matches('iframe, webview') || (!updated && entries.has(element))) return;
    const text = element.getAttribute('title');
    const previous = entries.get(element);
    if (previous) releaseAria(element, previous);
    if (!text) {
      entries.delete(element);
      element.removeAttribute(managedTitle);
      return;
    }
    const entry: TitleEntry = { text };
    entries.set(element, entry);
    element.setAttribute(managedTitle, text);
    element.setAttribute('title', '');
    // Retain title-only icon names and supplementary help for assistive tech.
    if (element.matches('button, [role="button"], a[href]') && !element.textContent?.trim()
        && !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) {
      element.setAttribute('aria-label', entry.label = text);
    } else if (!element.hasAttribute('aria-description')) {
      element.setAttribute('aria-description', entry.description = text);
    }
  }
  function visit(node: Node, query: string, action: (element: Element) => void) {
    if (!(node instanceof Element)) return;
    if (node.matches(query)) action(node);
    node.querySelectorAll(query).forEach(element => action(element));
  }
  const options: MutationObserverInit = {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['title', 'data-tooltip', 'aria-label', 'aria-keyshortcuts', 'aria-haspopup', 'aria-expanded', 'data-shortcut', 'inert'],
  };
  const observer = new MutationObserver(records => {
    // Our own title/ARIA writes must not be mistaken for component updates.
    observer.disconnect();
    const changed = new Set<Element>();
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName === 'title') changed.add(record.target as Element);
      for (const node of record.removedNodes) if (!node.isConnected) visit(node, selector, release);
    }
    for (const element of changed) {
      if (element.isConnected) capture(element, true); else release(element);
    }
    for (const record of records) {
      for (const node of record.addedNodes) if (node.isConnected) visit(node, '[title]', capture);
    }
    observer.observe(document.body, options);
    onChange();
  });
  visit(document.body, '[title]', capture);
  observer.observe(document.body, options);
  return () => {
    observer.disconnect();
    for (const element of entries.keys()) release(element);
  };
}
