import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

type Reference = { tabId: string; pageId?: string; url?: string };
type Entry = { tabId: string; ownerId: number; guestId: number };
type Scope = { ownerId: number; entries: Map<string, Entry>; selected: string };
export type BrowserTabAction = { action: 'open' | 'activate' | 'close'; tabId: string; url?: string };
const pageCommands = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'DOM.resolveNode', 'DOM.describeNode', 'DOM.getContentQuads',
  'DOM.getFrameOwner', 'DOM.getNodeForLocation', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObject',
  'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Input.insertText', 'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
]);

function unavailable(message: string, code = 'cardbush_page_unavailable'): never {
  throw Object.assign(new Error(message), { code });
}
function pageUrl(value: unknown): string {
  if (value === 'about:blank') return value;
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('CardBush browser control requires an HTTP(S) page without URL credentials.');
  return url.href;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined, cancel: () => void): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason); try { cancel(); } catch { /* The guest may already be gone. */ } };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Only registered inspector guests, never the application renderer or unrelated previews. */
export class IntegratedBrowser {
  private readonly entries = new Map<string, Entry>();
  private readonly scopes = new Map<string, Scope>();
  private readonly attached = new Set<number>();
  constructor(private readonly options: {
    getContents: (id: number) => WebContents | undefined;
    defaultOwner: () => WebContents | null;
    action: (ownerId: number, action: BrowserTabAction) => void;
  }) {}
  private key(ownerId: number, tabId: string) { return JSON.stringify([ownerId, tabId]); }
  register(owner: WebContents, input: { tabId: string; guestWebContentsId: number }): void {
    if (typeof input?.tabId !== 'string' || !input.tabId || input.tabId.length > 8192 || !Number.isSafeInteger(input.guestWebContentsId)) throw new Error('Invalid CardBush browser registration.');
    const guest = this.options.getContents(input.guestWebContentsId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents?.id !== owner.id || owner.isDestroyed() || guest.getType() !== 'webview') unavailable('This page does not belong to the requesting CardBush window.');
    pageUrl(guest.getURL());
    const key = this.key(owner.id, input.tabId);
    const previous = this.entries.get(key);
    if (previous?.guestId === guest.id) return;
    const entry = { tabId: input.tabId, ownerId: owner.id, guestId: guest.id };
    this.entries.set(key, entry);
    guest.once('destroyed', () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.attached.delete(guest.id);
    });
  }
  unregister(ownerId: number, input: { tabId: string; guestWebContentsId: number }): void {
    const key = this.key(ownerId, input.tabId), entry = this.entries.get(key);
    if (entry?.guestId !== input.guestWebContentsId) return;
    this.entries.delete(key);
    this.detach(entry.guestId);
  }
  /** Explicit @ selections grant only these exact guests to the submitting conversation. */
  bind(owner: WebContents, scopeId: string, references: Reference[]) {
    if (!scopeId || scopeId.length > 160 || !Array.isArray(references) || !references.length || references.length > 32) throw new Error('Invalid CardBush browser reference scope.');
    const selected = references.map(reference => {
      const entry = this.entries.get(this.key(owner.id, reference.tabId));
      if (!entry || reference.pageId !== undefined && String(entry.guestId) !== reference.pageId) unavailable('The referenced CardBush tab was closed or replaced. Select the tab again with @; Chrome/Edge will not be used.');
      this.guest(entry);
      return entry;
    });
    const previous = this.scopes.get(scopeId);
    const scope: Scope = previous?.ownerId === owner.id ? previous : { ownerId: owner.id, entries: new Map(), selected: '' };
    for (const entry of selected) scope.entries.set(entry.tabId, entry);
    scope.selected = selected[0].tabId;
    this.scopes.set(scopeId, scope);
    this.options.action(owner.id, { action: 'activate', tabId: scope.selected });
    return selected.map(entry => ({ ...this.page(entry, scope), browser: 'cardbush' as const }));
  }
  hasScope(scopeId: string): boolean { return this.scopes.has(scopeId); }
  select(scopeId: string): void {
    if (this.scopes.has(scopeId)) return;
    const owner = this.options.defaultOwner();
    if (!owner || owner.isDestroyed()) unavailable('No CardBush window is available.', 'cardbush_browser_unavailable');
    this.scopes.set(scopeId, { ownerId: owner.id, entries: new Map(), selected: '' });
  }
  private guest(entry: Entry): WebContents {
    const guest = this.options.getContents(entry.guestId);
    if (this.entries.get(this.key(entry.ownerId, entry.tabId))?.guestId !== entry.guestId || !guest || guest.isDestroyed() || guest.hostWebContents?.id !== entry.ownerId) {
      unavailable('The selected CardBush tab is no longer available. Re-select it with @ or explicitly choose another tab. No other browser was used.');
    }
    pageUrl(guest.getURL());
    return guest;
  }
  private page(entry: Entry, scope: Scope) {
    const guest = this.guest(entry);
    return { id: guest.id, tabId: entry.tabId, title: guest.getTitle(), url: guest.getURL(), active: entry.tabId === scope.selected,
      selected: entry.tabId === scope.selected, browser: 'cardbush', targetKey: `cardbush:${guest.id}` };
  }
  private detach(id: number): void {
    if (!this.attached.delete(id)) return;
    const guest = this.options.getContents(id);
    if (guest && !guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
  }
  release(scopeId: string): void {
    const scope = this.scopes.get(scopeId);
    if (!scope) return;
    for (const entry of scope.entries.values()) this.detach(entry.guestId);
  }
  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const scopeId = String(params.scopeId ?? ''), scope = this.scopes.get(scopeId);
    if (!scope) unavailable('Select CardBush with select_browser before using its pages.', 'cardbush_browser_unselected');
    if (method === 'debugger.detachScope') { this.release(scopeId); return { released: true, browser: 'cardbush' }; }
    if (method === 'tabs.create') {
      const url = pageUrl(params.url), tabId = `browser:${randomUUID()}`;
      this.options.action(scope.ownerId, { action: 'open', tabId, url });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const entry = this.entries.get(this.key(scope.ownerId, tabId));
        if (entry) { scope.entries.set(tabId, entry); scope.selected = tabId; return this.page(entry, scope); }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      unavailable('CardBush requested a new tab but it has not become ready. It may still open; do not automatically replay this request.', 'cardbush_page_open_timeout');
    }
    if (method === 'tabs.list') {
      // A missing explicitly selected tab must not silently select a different live tab.
      const selected = scope.entries.get(scope.selected);
      if (selected) this.guest(selected);
      return [...scope.entries.values()].flatMap(entry => {
        try { return [this.page(entry, scope)]; } catch { return []; }
      });
    }
    const entry = [...scope.entries.values()].find(item => item.guestId === params.tabId);
    if (!entry) unavailable('This CardBush page was not selected or created in this conversation.', 'cardbush_page_not_authorized');
    const guest = this.guest(entry);
    if (method === 'tabs.activate') {
      scope.selected = entry.tabId;
      this.options.action(scope.ownerId, { action: 'activate', tabId: entry.tabId });
      return this.page(entry, scope);
    }
    if (method === 'tabs.close') {
      this.options.action(scope.ownerId, { action: 'close', tabId: entry.tabId });
      this.unregister(scope.ownerId, { tabId: entry.tabId, guestWebContentsId: guest.id });
      scope.entries.delete(entry.tabId);
      if (scope.selected === entry.tabId) scope.selected = '';
      return { closed: true, pageId: guest.id };
    }
    if (method === 'tabs.navigate') {
      if (params.action === 'url') await abortable(guest.loadURL(pageUrl(params.url)), signal, () => guest.stop());
      else if (params.action === 'back') { if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); }
      else if (params.action === 'forward') { if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); }
      else if (params.action === 'reload') { if (params.ignoreCache) guest.reloadIgnoringCache(); else guest.reload(); }
      else throw new Error('Unsupported navigation action.');
      return this.page(entry, scope);
    }
    if (method === 'debugger.command') {
      const command = String(params.command ?? '');
      // Page-scoped CDP only: no Target/Browser commands that can reach other guests or the app.
      if (!pageCommands.has(command)) throw new Error('Unsupported CardBush page command.');
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3'); this.attached.add(guest.id);
        guest.debugger.once('detach', () => this.attached.delete(guest.id));
      }
      else if (!this.attached.has(guest.id)) unavailable('This tab is being debugged elsewhere. Close its developer tools before controlling it.', 'cardbush_debugger_busy');
      signal?.throwIfAborted();
      return abortable(guest.debugger.sendCommand(command, params.commandParams as Record<string, unknown> ?? {}), signal, () => this.detach(guest.id));
    }
    unavailable('This operation is not available in the CardBush browser. The request was not redirected to Chrome or Edge.', 'cardbush_browser_unsupported_method');
  }
}
