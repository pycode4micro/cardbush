import { useSyncExternalStore } from 'react';
import type { PermissionMode, SubagentPermissionRouting } from '../../types';
import { normalizePermissionMode } from '../../shared/permissionModes';

const modeKey = 'cardbush.assistant_permission_mode';
const routingKey = 'cardbush.assistant_subagent_permission_routing';
const changeEvent = 'cardbush:assistant-permissions';

const readMode = (): PermissionMode => normalizePermissionMode(window.localStorage.getItem(modeKey) ?? 'all_free');
const readRouting = (): SubagentPermissionRouting => window.localStorage.getItem(routingKey) === 'user' ? 'user' : 'parent';

export function readAssistantPermissions() {
  return { permissionMode: readMode(), subagentPermissionRouting: readRouting() };
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === modeKey || event.key === routingKey) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(changeEvent, onChange);
  };
}

function save(key: string, value: string) {
  window.localStorage.setItem(key, value);
  window.dispatchEvent(new Event(changeEvent));
}

export function useAssistantPermissions() {
  return {
    permissionMode: useSyncExternalStore(subscribe, readMode),
    subagentPermissionRouting: useSyncExternalStore(subscribe, readRouting),
    onPermissionModeChange: (mode: PermissionMode) => save(modeKey, mode),
    onSubagentPermissionRoutingChange: (routing: SubagentPermissionRouting) => save(routingKey, routing),
  };
}
