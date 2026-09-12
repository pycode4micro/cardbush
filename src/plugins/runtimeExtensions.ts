import { useEffect, useSyncExternalStore } from 'react';
import type { RuntimeRendererExtension, RuntimeRendererHost, RuntimeRendererSnapshot } from '@cardbush/bush-runtime';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import { synchronizeProductMcpSnapshot } from '../backend/productMcp';

interface Entry { id: string; name: string; hash?: string; extension?: RuntimeRendererExtension<HTMLElement>; snapshot?: RuntimeRendererSnapshot; unsubscribe?: () => void; error?: string }
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revision = 0;
let pending: Promise<void> | undefined;
let stopWatching: (() => void) | undefined;
function publish() { revision++; listeners.forEach(listener => listener()); }
function dispose(entry: Entry) {
  try { entry.unsubscribe?.(); } catch (error) { console.warn('Plugin subscription cleanup failed', error); }
  try { entry.extension?.dispose(); } catch (error) { console.warn('Plugin UI cleanup failed', error); }
}
function snapshot(entry: Entry) {
  try {
    const value = entry.extension!.getSnapshot();
    if (!value || typeof value.title !== 'string' || typeof value.selectedId !== 'string' || !Array.isArray(value.choices) || value.choices.some(choice => !choice || typeof choice.id !== 'string' || typeof choice.name !== 'string' || typeof choice.description !== 'string')) throw new Error('Invalid plugin selection state.');
    entry.snapshot = value;
  } catch (error) { entry.snapshot = undefined; entry.error = error instanceof Error ? error.message : String(error); }
}
function hostFor(pluginId: string): RuntimeRendererHost {
  return {
    async command(kind, payload) {
      const runtime = createDesktopRuntimeSession();
      try { return await runtime.client.command({ kind, payload }, value => value); } finally { runtime.dispose(); }
    },
    async synchronizeTools() {
      const runtime = createDesktopRuntimeSession();
      try { await synchronizeProductMcpSnapshot(runtime.client); } finally { runtime.dispose(); }
    },
    configurationFile: input => window.cardbushDesktop!.runtimePluginFile({ ...input, pluginId }),
  };
}
export function refreshRuntimeRendererPlugins(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    const bridge = window.cardbushDesktop;
    if (!bridge?.runtimePluginRenderers) return;
    const packages = await bridge.runtimePluginRenderers();
    const wanted = new Set(packages.map(pkg => pkg.id));
    for (const [id, prior] of entries) if (!wanted.has(id)) {
      dispose(prior); entries.delete(id); publish();
    }
    for (const pkg of packages) {
      const prior = entries.get(pkg.id);
      if (!pkg.error && prior?.extension && !prior.error && prior.hash === pkg.hash) continue;
      if (prior) dispose(prior);
      const next: Entry = { id: pkg.id, name: pkg.name, hash: pkg.hash };
      entries.set(pkg.id, next);
      try {
        if (pkg.error || !pkg.source) throw new Error(pkg.error || 'Missing plugin UI bundle.');
        const url = URL.createObjectURL(new Blob([pkg.source], { type: 'text/javascript' }));
        let module;
        try { module = await import(/* @vite-ignore */ url); } finally { URL.revokeObjectURL(url); }
        if (module.apiVersion !== 1 || typeof module.default !== 'function') throw new Error('Unsupported plugin UI API.');
        const extension: RuntimeRendererExtension<HTMLElement> = module.default(hostFor(pkg.id));
        if (extension?.apiVersion !== 1 || ['mount', 'subscribe', 'getSnapshot', 'load', 'select', 'dispose'].some(key => typeof (extension as unknown as Record<string, unknown>)[key] !== 'function')) throw new Error('Invalid plugin UI contribution.');
        next.extension = extension;
        snapshot(next);
        if (next.error) throw new Error(next.error);
        next.unsubscribe = extension.subscribe(() => { snapshot(next); publish(); });
        await extension.load(true);
      } catch (error) { next.error = error instanceof Error ? error.message : String(error); }
      publish();
    }
  })().catch(error => {
    for (const entry of entries.values()) dispose(entry);
    entries.clear(); publish();
    console.warn('Optional plugin UI catalog failed', error);
  }).finally(() => { pending = undefined; });
  return pending;
}
export function useRuntimeRendererPlugins() {
  useEffect(() => {
    if (!stopWatching) stopWatching = window.cardbushDesktop?.onCapabilityCatalogChanged?.(() => { void refreshRuntimeRendererPlugins(); });
    void refreshRuntimeRendererPlugins();
  }, []);
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision, () => revision);
  return [...entries.values()];
}
const empty: RuntimeRendererSnapshot = { title: '', choices: [], selectedId: '' };
export function useRuntimeDelegationWorkspace() {
  const plugins = useRuntimeRendererPlugins();
  const plugin = plugins.find(entry => entry.snapshot?.role === 'delegation');
  return { extensionId: plugin?.id, pluginName: plugin?.name || '', ...(plugin?.snapshot ?? empty),
    ...(plugin?.error ? { error: plugin.error, choices: [], selectedId: '' } : {}) };
}
export function selectRuntimePluginChoice(id: string, choice: string) { entries.get(id)?.extension?.select(choice); }
export async function prepareRuntimePluginTurn(request: unknown, tools: unknown[]) {
  await refreshRuntimeRendererPlugins();
  for (const { extension } of entries.values()) await extension?.prepareTurn?.(request, tools);
}
export async function resetRuntimePluginAssets(categories: string[]) {
  await refreshRuntimeRendererPlugins();
  const reset: string[] = [];
  for (const { extension } of entries.values()) {
    const result = await extension?.invoke?.('reset-assets', categories);
    if (Array.isArray(result)) reset.push(...result.filter(item => typeof item === 'string'));
  }
  return reset;
}
