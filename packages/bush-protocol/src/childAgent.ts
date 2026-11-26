import type { RuntimePermissionMode } from './permissionMode.js';

export const CARDBUSH_SUBAGENT_CONFIG_PROTOCOL =
  "cardbush.subagent_configuration.v1" as const;

/** Execution restrictions. Keep the declarations visible to preserve the parent prompt prefix. */
export const DEFAULT_CHILD_AGENT_DISABLED_TOOLS = [
  "subagent",
  "team_delegate",
  "request_user_input_async",
  "update_goal",
  "schedule_task",
] as const;

export type ChildAgentModelPolicy =
  | { mode: "inherit" }
  | { mode: "fixed"; modelId: string };

export interface ChildAgentConfiguration {
  protocol: typeof CARDBUSH_SUBAGENT_CONFIG_PROTOCOL;
  permissionRouting: "user" | "parent";
  childPermissionMode: RuntimePermissionMode;
  model: ChildAgentModelPolicy;
  disabledTools: string[];
}
