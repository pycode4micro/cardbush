import {
  runtimeSessionTurnRequestSchema,
  type ReasoningEffort,
  type RuntimeProviderBindingRef,
  type RuntimeSessionTurnRequest,
  type ToolDefinition,
} from "@cardbush/bush-protocol";

export const ROOT_AGENT_SYSTEM_PROMPT = `You are CardBush, a local general-purpose Agent. Work from the user's semantic request and the facts returned by the Tools actually exposed to this Turn.

For delivery or review work, use update_task_plan when a visible plan materially helps. When specialized knowledge may materially improve the result, search the installed Skill catalog and read the selected Skill resources before execution. Delegate only substantial independent workstreams; keep coupled or sequential work in the current Agent. A subagent dispatch is asynchronous and returns a task ID immediately: after dispatch, continue useful independent work and reconcile each delivered subagent_result before the final response. When no independent work remains and tasks are still outstanding, call await_subagents once; do not poll. Dispatch several independent workstreams as separate subagent calls when useful. Inspect before changing existing resources, execute the requested work, and verify it in proportion to risk. If a Tool asks for permission, wait for the user's exact answer rather than attempting an alternate route.

Default to a concise final response stating the outcome, verification and remaining risk. For every local deliverable, include its absolute path. Do not repeat logs or the user's request unless needed to explain a failure. In Goal mode, update_goal before completing the Turn.`;

export const CHILD_AGENT_SYSTEM_PROMPT = `You are an independently executing child Agent. The parent has supplied the relevant pre-dispatch context and one bounded assignment. Complete that assignment directly with the Tools exposed to you, verify your own result, and report a concise terminal result. Do not delegate further. Include absolute paths for local deliverables.`;

export const GOAL_CONTINUATION_PROMPT = `检查当前目标是否已经完成。若尚未完成，继续推进目标；若已经完成或确实无法继续，通过 update_goal 提交准确状态。`;

export interface ProductAgentTurnInput {
  requestId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  createdAt: string;
  localDate: string;
  userText: string;
  userMessageName?: string;
  model: string;
  providerBinding?: RuntimeProviderBindingRef;
  tools: ToolDefinition[];
  projectDir?: string;
  projectInstructions?: string;
  files?: string[];
  images?: string[];
  permissionMode: string;
  subagentPermissionRouting?: "user" | "parent";
  childAgentPolicy?: Record<string, unknown>;
  interactiveRequestsEnabled?: boolean;
  userChoiceEnabled?: boolean;
  visionEnabled?: boolean;
  teamId?: string;
  allowedSkills?: string[];
  planEnabled: boolean;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  reasoningEffort?: ReasoningEffort;
  sessionTitle?: string;
  sessionMetadata?: Record<string, unknown>;
}

export function createProductAgentTurnRequest(
  input: ProductAgentTurnInput,
): RuntimeSessionTurnRequest {
  const projectDir = input.projectDir?.trim() ?? "";
  const context = runtimeContext(input, projectDir);
  return runtimeSessionTurnRequestSchema.parse({
    protocol: "bush.session_turn_request.v1",
    requestId: input.requestId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    model: input.model,
    providerBinding: input.providerBinding,
    prefixMessages: [
      { role: "system", content: ROOT_AGENT_SYSTEM_PROMPT },
      ...(context ? [{
        role: "developer" as const,
        name: "runtime_context",
        content: context,
      }] : []),
    ],
    inputMessages: [
      {
        messageId: input.messageId,
        createdAt: input.createdAt,
        message: {
          role: "user",
          ...(input.userMessageName ? { name: input.userMessageName } : {}),
          content: input.userText,
          ...(input.images?.length
            ? { images: input.images.slice(0, 4).map((url) => ({ url })) }
            : {}),
        },
      },
    ],
    sessionMetadata: input.sessionMetadata ?? {
      title: input.sessionTitle ?? initialTitle(input.userText),
      ...(projectDir ? { projectDir } : {}),
    },
    tools: input.tools,
    toolChoice: "auto",
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
    requestCapabilities: {
      vision: input.visionEnabled === true,
      interactiveRequests: input.interactiveRequestsEnabled === true,
      userChoice:
        input.interactiveRequestsEnabled === true && input.userChoiceEnabled === true,
    },
    permissionMode: input.permissionMode,
    metadata: {
      source: "cardbush_product_agent",
      ...(projectDir ? { workspaceDir: projectDir, projectDir } : {}),
      permissionMode: input.permissionMode,
      subagentPermissionRouting: input.subagentPermissionRouting ?? "user",
      ...(input.childAgentPolicy ? { childAgentPolicy: input.childAgentPolicy } : {}),
      mcpContext: { filesystemRoots: projectDir ? [projectDir] : [] },
      teamId: input.teamId,
      allowedSkills: input.allowedSkills ?? [],
      planEnabled: input.planEnabled,
      contextWindowTokens: input.maxContextTokens,
      subagentChildPrefixMessages: [{ role: "system", content: CHILD_AGENT_SYSTEM_PROMPT }],
    },
  });
}

function runtimeContext(input: ProductAgentTurnInput, projectDir: string): string {
  const content = [
    projectDir ? `Workspace: ${projectDir}` : "",
    input.projectInstructions?.trim()
      ? `Project instructions:\n${input.projectInstructions.trim()}`
      : "",
    input.files?.length ? `Attached files:\n${input.files.join("\n")}` : "",
    input.images?.length ? `Attached images:\n${input.images.join("\n")}` : "",
    `Local date: ${input.localDate}`,
  ].filter(Boolean).join("\n");
  return content ? `<runtime_context>\n${content}\n</runtime_context>` : "";
}

function initialTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}
