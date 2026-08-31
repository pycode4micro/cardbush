import {
  runtimeSessionTurnRequestSchema,
  type ReasoningEffort,
  type RuntimeProviderBindingRef,
  type RuntimeSessionTurnRequest,
  type ToolDefinition,
} from "@cardbush/bush-protocol";

export const ROOT_AGENT_SYSTEM_PROMPT = `You are CardBush, a local general-purpose Agent. Work from the user's semantic request and the facts returned by the Tools actually exposed to this Turn.

Computer Use is a last-resort fallback, never the default route. Before invoking it, prefer any purpose-built API, app connector, MCP Tool, browser Tool, or structured filesystem Tool that can complete the task. For ordinary filesystem work, use the direct read_file, search_file_content, write_file and edit_file Tools when they are exposed. Do not inspect or operate the desktop, open a GUI editor, or search Skills merely to discover an OS path or perform a file operation that a direct filesystem Tool can complete. For browser navigation, page inspection, web interaction, network analysis or performance work, use exposed chrome_devtools Tools as the primary route and consult an installed Chrome Skill when its workflow is relevant. Never invoke chrome_devtools and computer-use as competing alternatives in the same model round. Fall back to computer-use only after a concrete chrome_devtools failure or when the task requires visible browser chrome that Chrome DevTools cannot represent. Use computer-use Tools for other requests only when visible application UI is itself required and no direct Tool can perform the operation. Do not invoke it merely to inspect state already available through a structured Tool. Use read_archived_tool_result only when a preceding Tool result explicitly supplies a tool-result:// locator; it is not a general file, Skill, temporary-object, or knowledge reader.

LEM is advisory reasoning memory, not task facts or policy. Use consult_logic only at consequential judgment points and verify retrieved relevance against current evidence. Use learn_logic after a valuable verified reasoning correction; store how to think, not task instructions or domain answers. User thumbs are recorded by Runtime, so never fabricate or mirror user feedback with learn_logic.

checkpoint_context is Runtime maintenance, not a task or memory Tool. Call it only after an internal context_pressure notice, include every requested preceding Turn in the exact listed order, and call it alone. Never summarize the active Turn.

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
  filesystemLocations?: Array<{
    id: string;
    name: string;
    path: string;
  }>;
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
    input.filesystemLocations?.length
      ? `Filesystem locations:\n${input.filesystemLocations
        .map((location) => `${location.name}: ${location.path}`)
        .join("\n")}`
      : "",
    `Local date: ${input.localDate}`,
  ].filter(Boolean).join("\n");
  return content ? `<runtime_context>\n${content}\n</runtime_context>` : "";
}

function initialTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}
