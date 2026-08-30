export const CARDBUSH_SUBAGENT_CONFIG_PROTOCOL =
  "cardbush.subagent_configuration.v1" as const;

export const DEFAULT_CHILD_AGENT_DISABLED_TOOLS = [
  "subagent",
  "await_subagents",
  "team_delegate",
  "request_permission",
  "request_user_choice",
  "update_goal",
  "schedule_task",
] as const;

export type ChildAgentModelPolicy =
  | { mode: "inherit" }
  | { mode: "fixed"; modelId: string };

export interface ChildAgentConfiguration {
  protocol: typeof CARDBUSH_SUBAGENT_CONFIG_PROTOCOL;
  permissionRouting: "user" | "parent";
  childPermissionMode: "task_free" | "user_free" | "all_free";
  model: ChildAgentModelPolicy;
  disabledTools: string[];
}
