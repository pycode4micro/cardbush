let pending: { id: string; nonce: number; extensionId?: string } | undefined;
const listeners = new Set<() => void>();
export function requestPluginDetails(id: string) { pending = { id, nonce: Date.now() }; listeners.forEach(notify => notify()); }
export function requestPluginApplication(id: string, extensionId: string) { pending = { id, extensionId, nonce: Date.now() }; listeners.forEach(notify => notify()); }
export function takePluginDetailsRequest() { const value = pending; pending = undefined; return value; }
export function subscribePluginDetailsRequest(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; }
