import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { createCardbushChromeServer, createBrowserUseState, ChromeConnectorError, requestChromeConnector } from '@cardbush/chrome-mcp';
import { startDesktopMcpServer } from './desktopMcpServer.mjs';
import type { IntegratedBrowser } from './integratedBrowser.js';

type Params = Record<string, unknown>;
type Options = NonNullable<Parameters<typeof requestChromeConnector>[2]>;

/** One Browser Use API, with an explicit per-conversation browser identity. No URL-based fallback. */
export class BrowserUseRouter {
  private readonly routes = new Map<string, 'cardbush' | 'external'>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly integrated: IntegratedBrowser, private readonly options: {
    routesPath?: string; external: typeof requestChromeConnector;
  }) {
    if (options.routesPath) {
      try {
        const saved = JSON.parse(readFileSync(options.routesPath, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.routes) || saved.routes.length > 4096) throw new Error('Invalid Browser Use routes.');
        for (const [scope, route] of saved.routes) {
          if (typeof scope !== 'string' || !scope || scope.length > 160 || !['cardbush', 'external'].includes(route)) throw new Error('Invalid Browser Use route.');
          this.routes.set(scope, route);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private save(scope: string, route: 'cardbush' | 'external') {
    if (!this.routes.has(scope) && this.routes.size >= 4096) throw new Error('Browser Use session route limit reached.');
    const previous = this.routes.get(scope);
    this.routes.set(scope, route);
    if (!this.options.routesPath) return;
    const target = this.options.routesPath;
    try {
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, routes: [...this.routes] }), { mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) { if (previous) this.routes.set(scope, previous); else this.routes.delete(scope); throw error; }
  }
  private serialized<T>(scope: string, run: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(scope) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(scope, pending);
    void pending.finally(() => { if (this.queues.get(scope) === pending) this.queues.delete(scope); }).catch(() => {});
    return pending;
  }
  bindReferences(owner: WebContents, scope: string, references: Array<{ tabId: string; pageId?: string; url?: string }>) {
    return this.serialized(scope, async () => {
      const pages = this.integrated.bind(owner, scope, references);
      await this.releaseExternal(scope);
      this.save(scope, 'cardbush');
      return pages;
    });
  }
  /** Called through private Runtime RPC after the host verifies child ownership. */
  inheritScope(parent: string, child: string, signal?: AbortSignal) {
    if ([parent, child].some(scope => typeof scope !== 'string' || !scope || scope.length > 160) || parent === child)
      return Promise.reject(new Error('Invalid browser delegation scopes.'));
    return this.serialized(parent, () => this.serialized(child, async () => {
      signal?.throwIfAborted();
      if (this.routes.get(parent) !== 'cardbush') return { inherited: false };
      // Guidance without a new parent binding must preserve both the child's
      // page selection and any browser it explicitly chose while working.
      if (this.integrated.hasInheritedScope(parent, child)) return { inherited: true };
      // Persist the browser identity first so a stale/missing grant cannot fall
      // through to Chrome/Edge, including after a restart or failed transfer.
      await this.releaseExternal(child, { signal });
      signal?.throwIfAborted();
      this.save(child, 'cardbush');
      return { inherited: this.integrated.inheritScope(parent, child) };
    }));
  }
  private async releaseExternal(scope: string, options: Options = {}) {
    if (this.routes.get(scope) !== 'external') return;
    try { await this.options.external('debugger.detachScope', { scopeId: scope }, options); }
    catch (error) {
      // An explicit choice can leave a disconnected browser; never replay its pending action.
      if (!['browser_unavailable', 'bridge_config_missing', 'bridge_config_unavailable', 'cardbush_bridge_unavailable'].includes(String((error as { code?: string }).code))) throw error;
    }
  }
  request = (method: string, params: Params = {}, options: Options = {}): Promise<unknown> => {
    const scope = String(params.scopeId ?? '');
    if (!scope || scope.length > 160) return Promise.reject(new ChromeConnectorError('browser_scope_missing', 'A CardBush conversation is required.'));
    return this.serialized(scope, () => this.route(method, params, options)).catch(error => {
      if (error instanceof ChromeConnectorError || error?.name === 'AbortError') throw error;
      throw new ChromeConnectorError(String(error?.code ?? 'cardbush_browser_failed'), error instanceof Error ? error.message : String(error));
    });
  };
  private async route(method: string, params: Params, options: Options): Promise<unknown> {
    options?.signal?.throwIfAborted();
    const scope = String(params.scopeId), route = this.routes.get(scope);
    if (method === 'browser.list') {
      let external: Params = {};
      try { external = await this.options.external(method, params, options) as Params; }
      catch (error) { external = { connections: [], externalError: error instanceof Error ? error.message : String(error) }; }
      return { ...external, connections: [
        { id: 'cardbush', browser: 'cardbush', name: 'CardBush', label: 'CardBush integrated browser', connected: true, requiresPairing: false },
        ...(Array.isArray(external.connections) ? external.connections : []),
      ], selectedConnectionId: route === 'cardbush' ? 'cardbush' : external.selectedConnectionId ?? null,
        defaultConnectionId: external.defaultConnectionId ?? null };
    }
    if (method === 'browser.select') {
      if (params.connectionId === 'cardbush') {
        await this.releaseExternal(scope, options);
        this.integrated.select(scope); this.save(scope, 'cardbush');
        return { connectionId: 'cardbush' };
      }
      const selected = await this.options.external(method, params, options);
      this.integrated.release(scope); this.save(scope, 'external');
      return selected;
    }
    if (route === 'cardbush') {
      if (!this.integrated.hasScope(scope)) throw new ChromeConnectorError('cardbush_browser_reselect_required',
        'This conversation is bound to CardBush. After restart, select the intended tab again with @ (or explicitly select CardBush to create a new tab). Chrome/Edge was not used.');
      if (typeof params.expectedTargetKey === 'string' && !params.expectedTargetKey.startsWith('cardbush:')) throw new ChromeConnectorError('browser_target_changed', 'The user selected a CardBush tab. Take a fresh snapshot; old browser element ids cannot be reused.');
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new ChromeConnectorError('cardbush_browser_timeout',
        'CardBush browser operation timed out. An action may already have executed; observe the page before retrying. No other browser was used.')), options.timeoutMs ?? 30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
      try { return await this.integrated.request(method, params, signal); }
      finally { clearTimeout(timer); }
    }
    if (typeof params.expectedTargetKey === 'string' && params.expectedTargetKey.startsWith('cardbush:')) throw new ChromeConnectorError('browser_target_changed', 'The selected browser changed. Take a fresh snapshot before another action.');
    const result = await this.options.external(method, params, options);
    if (!route) this.save(scope, 'external');
    return method === 'tabs.list' && Array.isArray(result)
      ? result.map(page => ({ ...page, browser: 'external', targetKey: `external:${page.id}` })) : result;
  }
}

export function startBrowserUseHost(router: BrowserUseRouter, options: { browserConfigPath: string; artifactsDirectory: string }) {
  const state = createBrowserUseState(options.artifactsDirectory);
  return startDesktopMcpServer(() => createCardbushChromeServer({ ...options, state, connector: router.request }));
}

export { requestChromeConnector };
