import { useEffect, useState } from 'react';
import type { PermissionMode, ReasoningLevel, ReferencePlanMode, SubagentPermissionRouting } from '../../types';

type Preferences = {
  modelId: string; reasoning: ReasoningLevel; plan: ReferencePlanMode;
  permissionMode: PermissionMode; routing: SubagentPermissionRouting; disabledSkills: string[]; visionEnabled: boolean;
};

/** UI preferences are scoped to the remote connection, never written into model history. */
export function useAgentChatPreferences(connectionId: string, defaultModelId: string) {
  const key = `cardbush-agent-preferences:${connectionId}`;
  const [preferences, setPreferences] = useState<Preferences>(() => {
    let value: Partial<Preferences> = {};
    try { value = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { /* Use defaults for invalid stored UI state. */ }
    return {
      modelId: typeof value.modelId === 'string' ? value.modelId : defaultModelId,
      reasoning: member(value.reasoning, ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
      plan: member(value.plan, ['off', 'auto'], 'off'),
      permissionMode: member(value.permissionMode, ['user_free', 'task_free', 'all_free'], 'task_free'),
      routing: member(value.routing, ['user', 'parent'], 'user'),
      disabledSkills: Array.isArray(value.disabledSkills) ? value.disabledSkills.filter(name => typeof name === 'string') : [],
      visionEnabled: value.visionEnabled === true,
    };
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(preferences)); } catch { /* A full storage quota must not block chat. */ }
  }, [key, preferences]);
  return [preferences, setPreferences] as const;
}

function member<T extends string>(value: unknown, values: T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}
