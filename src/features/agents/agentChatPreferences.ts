import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from 'react';
import type { PermissionMode, ReasoningLevel, ReferencePlanMode, SubagentPermissionRouting } from '../../types';
type Preferences = { modelId: string; reasoning: ReasoningLevel; plan: ReferencePlanMode;
  permissionMode: PermissionMode; routing: SubagentPermissionRouting; disabledSkills: string[]; visionEnabled?: boolean };
const changed = 'cardbush:agent-preferences-changed';
const memory = new Map<string, string>();
function read(key: string) {
  if (memory.has(key)) return memory.get(key)!;
  try { return localStorage.getItem(key) ?? '{}'; } catch { return '{}'; }
}
function parse(raw: string, defaultModelId: string): Preferences {
  let value: Partial<Preferences> = {};
  try { value = JSON.parse(raw) ?? {}; } catch { /* Invalid saved preferences use defaults. */ }
  return {
    modelId: typeof value.modelId === 'string' ? value.modelId : defaultModelId,
    reasoning: member(value.reasoning, ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
    plan: member(value.plan, ['off', 'auto'], 'off'),
    permissionMode: member(value.permissionMode, ['user_free', 'task_free', 'all_free'], 'task_free'),
    routing: member(value.routing, ['user', 'parent'], 'user'),
    disabledSkills: Array.isArray(value.disabledSkills) ? value.disabledSkills.filter(name => typeof name === 'string') : [],
    ...(typeof value.visionEnabled === 'boolean' ? { visionEnabled: value.visionEnabled } : {}),
  };
}
/** Chat and settings subscribe to the same preferences; reading never writes defaults. */
export function useAgentChatPreferences(connectionId: string, defaultModelId: string) {
  const key = 'cardbush-agent-preferences:' + connectionId;
  const subscribe = useCallback((listener: () => void) => {
    const notify = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === key || event.key === null) { memory.delete(key); listener(); }
      } else if ((event as CustomEvent<string>).detail === key) listener();
    };
    window.addEventListener(changed, notify); window.addEventListener('storage', notify);
    return () => { window.removeEventListener(changed, notify); window.removeEventListener('storage', notify); };
  }, [key]);
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]));
  const preferences = useMemo(() => parse(snapshot, defaultModelId), [snapshot, defaultModelId]);
  const setPreferences = useCallback((update: SetStateAction<Preferences>) => {
    const next = typeof update === 'function' ? update(parse(read(key), defaultModelId)) : update;
    const raw = JSON.stringify(next);
    try { localStorage.setItem(key, raw); memory.delete(key); } catch { memory.set(key, raw); }
    window.dispatchEvent(new CustomEvent(changed, { detail: key }));
  }, [key, defaultModelId]);
  return [preferences, setPreferences] as const;
}
function member<T extends string>(value: unknown, values: T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}
