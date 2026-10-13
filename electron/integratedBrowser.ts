import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

type Reference = { tabId: string; pageId?: string; url?: string };
type Entry = { tabId: string; ownerId: number; guestId: number; targetKey: string };
type Scope = { ownerId: number; entries: Map<string, Entry>; selected: string; bindingRevision: number;
  inheritedFrom?: { parentId: string; revision: number } };
export type BrowserTabAction = { action: 'open' | 'bind' | 'activate' | 'close' | 'inspect'; tabId: string;
  tabIds?: string[]; url?: string; sessionId?: string; requestId?: string };
export type BrowserTabPresentation = { tabId: string; guestWebContentsId: number | null; inWorkspace: boolean; active: boolean; visible: boolean };
export type BrowserTabActionResult = { requestId: string; pages: BrowserTabPresentation[] };
const pageCommands = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'DOM.resolveNode', 'DOM.describeNode', 'DOM.getContentQuads',
  'DOM.getFrameOwner', 'DOM.getNodeForLocation', 'DOM.setFileInputFiles', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObject',
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
  private readonly parents = new Map<string, string>();
  private readonly attached = new Set<number>();
  private readonly pendingActions = new Map<string, { ownerId: number; tabIds: string[]; resolve: (pages: BrowserTabPresentation[]) => void }>();
  constructor(private readonly options: {
    getContents: (id: number) => WebContents | undefined;
    defaultOwner: () => WebContents | null;
    action: (ownerId: number, action: BrowserTabAction) => void;
    ownerVisible?: (id: number) => boolean;
    actionTimeoutMs?: number;
  }) {}
  /** Replies are accepted only from the requesting app window, never a guest. */
  acknowledge(ownerId: number, result: BrowserTabActionResult): void {
    const pending = this.pendingActions.get(result?.requestId);
    if (!pending || pending.ownerId !== ownerId || !Array.isArray(result.pages) || result.pages.length !== pending.tabIds.length) return;
    if (result.pages.some(page => !page || typeof page !== 'object') ||
      pending.tabIds.some(id => result.pages.filter(page => page.tabId === id).length !== 1) || result.pages.some(page =>
      (page.guestWebContentsId !== null && !Number.isSafeInteger(page.guestWebContentsId)) ||
      ['inWorkspace', 'active', 'visible'].some(key => typeof page[key as keyof BrowserTabPresentation] !== 'boolean'))) return;
    pending.resolve(result.pages);
  }
  private present(scope: Scope, action: BrowserTabAction, signal?: AbortSignal): Promise<BrowserTabPresentation[]> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const requestId = randomUUID(), tabIds = action.tabIds ?? [action.tabId];
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pendingActions.delete(requestId); };
      const abort = () => { cleanup(); reject(signal?.reason); };
      const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error(
        'CardBush did not acknowledge the tab presentation. The page may exist, but visibility is unconfirmed. Do not create a replacement tab.'),
        { code: 'cardbush_presentation_timeout', details: { action: action.action, tabId: action.tabId, sessionId: action.sessionId } })); }, this.options.actionTimeoutMs ?? 3000);
      this.pendingActions.set(requestId, { ownerId: scope.ownerId, tabIds, resolve: pages => { cleanup(); resolve(pages); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.options.action(scope.ownerId, { ...action, requestId }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
  private async inspect(scopeId: string, scope: Scope, entries: Entry[], signal?: AbortSignal) {
    if (!entries.length) return [];
    return this.present(scope, { action: 'inspect', tabId: entries[0].tabId, tabIds: entries.map(entry => entry.tabId), sessionId: this.actionSession(scopeId) }, signal);
  }
  private requirePresented(entry: Entry, presentation: BrowserTabPresentation | undefined): void {
    if (presentation?.guestWebContentsId !== entry.guestId || !presentation.inWorkspace) throw Object.assign(new Error(
      'The original CardBush tab was not attached to this conversation. Re-select that tab with @; do not open a replacement.'),
      { code: 'cardbush_page_not_presented', details: { tabId: entry.tabId, expectedGuestId: entry.guestId, presentation } });
  }
  private key(ownerId: number, tabId: string) { return JSON.stringify([ownerId, tabId]); }
  private actionSession(scopeId: string): string {
    const visited = new Set<string>();
    while (!visited.has(scopeId)) {
      visited.add(scopeId);
      const parent = this.parents.get(scopeId);
      if (!parent) break;
      scopeId = parent;
    }
    return scopeId;
  }
  /** Return only a newly created guest through the host-verified task ancestry. */
  private grantCreatedPage(scopeId: string, entry: Entry): void {
    for (let parentId = this.parents.get(scopeId); parentId; parentId = this.parents.get(parentId)) {
      const previous = this.scopes.get(parentId);
      // A parent re-bound in another window must not receive an old-window guest.
      if (previous && previous.ownerId !== entry.ownerId) break;
      const parent = previous ?? { ownerId: entry.ownerId, entries: new Map<string, Entry>(), selected: '', bindingRevision: 0 };
      parent.entries.set(entry.tabId, entry);
      if (!parent.selected) parent.selected = entry.tabId;
      // An additive grant is not a new explicit binding. Keep both sides' page
      // choices, including on the next child continuation.
      this.scopes.set(parentId, parent);
    }
  }
  private forgetClosedPage(entry: Entry): void {
    for (const scope of this.scopes.values()) {
      if (scope.entries.get(entry.tabId) !== entry) continue;
      // Keep the selected guest as a tombstone. A later list or inherited scope
      // must not turn closing this tab into permission to target another one.
      if (scope.selected === entry.tabId) scope.bindingRevision++;
      else scope.entries.delete(entry.tabId);
    }
  }
  register(owner: WebContents, input: { tabId: string; guestWebContentsId: number }): void {
    if (typeof input?.tabId !== 'string' || !input.tabId || input.tabId.length > 8192 || !Number.isSafeInteger(input.guestWebContentsId)) throw new Error('Invalid CardBush browser registration.');
    const guest = this.options.getContents(input.guestWebContentsId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents?.id !== owner.id || owner.isDestroyed() || guest.getType() !== 'webview') unavailable('This page does not belong to the requesting CardBush window.');
    pageUrl(guest.getURL());
    const key = this.key(owner.id, input.tabId);
    const previous = this.entries.get(key);
    if (previous?.guestId === guest.id) return;
    const entry = { tabId: input.tabId, ownerId: owner.id, guestId: guest.id, targetKey: `cardbush:${randomUUID()}` };
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
  matchesReference(ownerId: number, tabId: string, targetKey: string): boolean {
    const entry = this.entries.get(this.key(ownerId, tabId));
    if (!entry || entry.targetKey !== targetKey) return false;
    try { this.guest(entry); return true; } catch { return false; }
  }
  /** Explicit @ selections grant only these exact guests to the submitting conversation. */
  async bind(owner: WebContents, scopeId: string, references: Reference[]) {
    if (!scopeId || scopeId.length > 160 || !Array.isArray(references) || !references.length || references.length > 32) throw new Error('Invalid CardBush browser reference scope.');
    const selected = references.map(reference => {
      const entry = this.entries.get(this.key(owner.id, reference.tabId));
      if (!entry || reference.pageId !== undefined && String(entry.guestId) !== reference.pageId) unavailable('The referenced CardBush tab was closed or replaced. Select the tab again with @; Chrome/Edge will not be used.');
      this.guest(entry);
      return entry;
    });
    const previous = this.scopes.get(scopeId);
    const scope: Scope = previous?.ownerId === owner.id ? previous : { ownerId: owner.id, entries: new Map(), selected: '', bindingRevision: 0 };
    for (const entry of selected) scope.entries.set(entry.tabId, entry);
    scope.selected = selected[0].tabId;
    scope.bindingRevision++;
    this.scopes.set(scopeId, scope);
    const tabIds = [...new Set(selected.map(entry => entry.tabId))];
    const presentations = await this.present(scope, { action: 'bind', tabId: scope.selected, tabIds, sessionId: this.actionSession(scopeId) });
    return selected.map(entry => {
      const presentation = presentations.find(page => page.tabId === entry.tabId);
      this.requirePresented(entry, presentation);
      return this.page(entry, scope, presentation);
    });
  }
  hasScope(scopeId: string): boolean { return this.scopes.has(scopeId); }
  /** Trusted task ownership determines where pages appear, independently of browser grants. */
  registerDelegation(parentId: string, childId: string): void {
    if ([parentId, childId].some(id => typeof id !== 'string' || !id || id.length > 160) || parentId === childId)
      throw new Error('Invalid browser delegation scopes.');
    const previous = this.parents.get(childId);
    if (previous && previous !== parentId) unavailable('The child belongs to another conversation.', 'cardbush_scope_parent_changed');
    for (let ancestor: string | undefined = parentId; ancestor; ancestor = this.parents.get(ancestor)) {
      if (ancestor === childId) unavailable('Browser delegation cannot contain a cycle.', 'cardbush_scope_cycle');
    }
    this.parents.set(childId, parentId);
  }
  hasInheritedScope(parentId: string, childId: string): boolean {
    const parent = this.scopes.get(parentId), child = this.scopes.get(childId);
    return !!parent && child?.ownerId === parent.ownerId && child.inheritedFrom?.parentId === parentId
      && child.inheritedFrom.revision === parent.bindingRevision;
  }
  /** Trusted local delegation only. Copy exact grants, never all registered tabs. */
  inheritScope(parentId: string, childId: string) {
    this.registerDelegation(parentId, childId);
    const parent = this.scopes.get(parentId);
    // A closed tab or lost scope must fail when it is used, not prevent an
    // otherwise unrelated child task from starting after a browser restart.
    if (!parent) return false;
    const previous = this.scopes.get(childId);
    if (previous && previous.ownerId !== parent.ownerId) unavailable('The parent browser window changed. Start a new child for the selected window.', 'cardbush_scope_owner_changed');
    const child: Scope = this.hasInheritedScope(parentId, childId) ? previous! : {
      ownerId: parent.ownerId, entries: new Map(previous?.entries), selected: parent.selected || previous?.selected || '',
      bindingRevision: (previous?.bindingRevision ?? 0) + 1, inheritedFrom: { parentId, revision: parent.bindingRevision } };
    // Preserve stale identities too: normal guest validation rejects them and
    // cannot silently select a different live tab if the chosen one has closed.
    for (const entry of parent.entries.values()) child.entries.set(entry.tabId, entry);
    this.scopes.set(childId, child);
    return true;
  }
  select(scopeId: string): void {
    if (this.scopes.has(scopeId)) return;
    const owner = this.options.defaultOwner();
    if (!owner || owner.isDestroyed()) unavailable('No CardBush window is available.', 'cardbush_browser_unavailable');
    this.scopes.set(scopeId, { ownerId: owner.id, entries: new Map(), selected: '', bindingRevision: 0 });
  }
  private guest(entry: Entry): WebContents {
    const guest = this.options.getContents(entry.guestId);
    if (this.entries.get(this.key(entry.ownerId, entry.tabId))?.guestId !== entry.guestId || !guest || guest.isDestroyed() || guest.hostWebContents?.id !== entry.ownerId) {
      unavailable('The selected CardBush tab is no longer available. Re-select it with @ or explicitly choose another tab. No other browser was used.');
    }
    pageUrl(guest.getURL());
    return guest;
  }
  private page(entry: Entry, scope: Scope, presentation?: BrowserTabPresentation) {
    const guest = this.guest(entry);
    const confirmed = presentation?.guestWebContentsId === guest.id;
    return { id: guest.id, tabId: entry.tabId, title: guest.getTitle(), url: guest.getURL(), active: confirmed && presentation.active,
      visible: confirmed && presentation.visible && (this.options.ownerVisible?.(entry.ownerId) ?? true),
      selected: entry.tabId === scope.selected, browser: 'cardbush', targetKey: entry.targetKey };
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
      this.options.action(scope.ownerId, { action: 'open', tabId, url, sessionId: this.actionSession(scopeId) });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const entry = this.entries.get(this.key(scope.ownerId, tabId));
        if (entry) {
          scope.entries.set(tabId, entry); scope.selected = tabId; scope.bindingRevision++;
          this.grantCreatedPage(scopeId, entry);
          const [presentation] = await this.inspect(scopeId, scope, [entry], signal);
          this.requirePresented(entry, presentation);
          return this.page(entry, scope, presentation);
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      unavailable('CardBush requested a new tab but it has not become ready. It may still open; do not automatically replay this request.', 'cardbush_page_open_timeout');
    }
    if (method === 'tabs.list') {
      // Listing is discovery, not target admission: stale selection must not
      // hide the remaining authorized tabs needed for explicit recovery.
      const entries = [...scope.entries.values()].filter(entry => { try { this.guest(entry); return true; } catch { return false; } });
      const presentations = await this.inspect(scopeId, scope, entries, signal);
      const pages = entries.flatMap(entry => {
        // The user may close a tab while the renderer confirms presentation.
        try { return [this.page(entry, scope, presentations.find(page => page.tabId === entry.tabId))]; }
        catch { return []; }
      });
      return {
        pages,
        selectedPageId: scope.entries.get(scope.selected)?.guestId ?? null,
        selectionState: !scope.selected ? 'none' : pages.some(page => page.selected) ? 'selected' : 'missing',
      };
    }
    const entry = [...scope.entries.values()].find(item => item.guestId === params.tabId);
    if (!entry) unavailable('This CardBush page was not selected or created in this conversation.', 'cardbush_page_not_authorized');
    const guest = this.guest(entry);
    if (method === 'tabs.activate') {
      scope.selected = entry.tabId;
      scope.bindingRevision++;
      const [presentation] = await this.present(scope, { action: 'activate', tabId: entry.tabId, sessionId: this.actionSession(scopeId) }, signal);
      this.requirePresented(entry, presentation);
      return this.page(entry, scope, presentation);
    }
    if (method === 'tabs.close') {
      const [presentation] = await this.present(scope, { action: 'close', tabId: entry.tabId, sessionId: this.actionSession(scopeId) }, signal);
      if (presentation?.guestWebContentsId != null) unavailable('CardBush has not closed the tab in the interface.', 'cardbush_page_close_unconfirmed');
      this.unregister(scope.ownerId, { tabId: entry.tabId, guestWebContentsId: guest.id });
      this.forgetClosedPage(entry);
      return { closed: true, pageId: guest.id };
    }
    if (method === 'tabs.navigate') {
      if (params.action === 'url') await abortable(guest.loadURL(pageUrl(params.url)), signal, () => guest.stop());
      else if (params.action === 'back') { if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); }
      else if (params.action === 'forward') { if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); }
      else if (params.action === 'reload') { if (params.ignoreCache) guest.reloadIgnoringCache(); else guest.reload(); }
      else throw new Error('Unsupported navigation action.');
      const [presentation] = await this.inspect(scopeId, scope, [entry], signal);
      return this.page(entry, scope, presentation);
    }
    if (method === 'debugger.command') {
      const command = String(params.command ?? '');
      // Page-scoped CDP only: no Target/Browser commands that can reach other guests or the app.
      if (!pageCommands.has(command)) throw new Error('Unsupported CardBush page command.');
      if (command === 'Page.captureScreenshot') {
        const [presentation] = await this.inspect(scopeId, scope, [entry], signal);
        if (!this.page(entry, scope, presentation).visible) throw Object.assign(new Error(
          'The selected CardBush tab is not visible. Show its conversation and select the existing tab before taking a screenshot. Do not create a replacement or alter the website DOM.'),
          { code: 'cardbush_page_not_visible', details: { pageId: guest.id, sessionId: this.actionSession(scopeId), inputDispatched: false } });
      }
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
