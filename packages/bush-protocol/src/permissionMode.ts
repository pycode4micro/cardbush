import { z } from 'zod';

export const approvalModes = ['ask_for_approval', 'all_free'] as const;
export type ApprovalMode = typeof approvalModes[number];

/** Legacy user-root grants are still honored for hosts and saved configurations. */
const permissionLevels = ['ask_for_approval', 'user_free', 'all_free'] as const;
export const permissionModeSchema = z.enum([...permissionLevels, 'task_free'])
  .transform(mode => mode === 'task_free' ? 'ask_for_approval' as const : mode);
export type RuntimePermissionMode = z.output<typeof permissionModeSchema>;

export function capPermissionMode(requested: RuntimePermissionMode, ceiling: RuntimePermissionMode): RuntimePermissionMode {
  return permissionLevels[Math.min(permissionLevels.indexOf(requested), permissionLevels.indexOf(ceiling))] ?? 'ask_for_approval';
}

/** Settings and model-facing controls have two choices. */
export function approvalMode(value: unknown): ApprovalMode {
  return typeof value === 'string' && value.trim() === 'all_free' ? 'all_free' : 'ask_for_approval';
}

/** HTTP v1 Agent peers can still require the original spelling. */
export function agentV1PermissionMode<T>(mode: T): T | 'task_free' {
  return mode === 'ask_for_approval' ? 'task_free' : mode;
}
