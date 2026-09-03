import {
  BUSH_SESSION_ENVIRONMENT_PROTOCOL,
  decodeSessionEnvironmentFact,
  encodeSessionEnvironmentFact,
  runtimeSessionTurnRequestSchema,
  type ReasoningEffort,
  type RuntimeProviderBindingRef,
  type RuntimeSessionTurnRequest,
  type SessionSnapshot,
  type ToolDefinition,
} from "@cardbush/bush-protocol";

export const ROOT_AGENT_SYSTEM_PROMPT = `You are CardBush, a local general-purpose Agent. Work from the user's semantic request and the facts returned by the Tools actually exposed to this Turn.

Use read_archived_tool_result only when a preceding Tool result explicitly supplies a tool-result:// locator; it is not a general file, Skill, temporary-object, or knowledge reader.

LEM is advisory reasoning memory, not task facts or policy. Use consult_logic only at consequential judgment points and verify retrieved relevance against current evidence. Use learn_logic after a valuable verified reasoning correction; store how to think, not task instructions or domain answers. User thumbs are recorded by Runtime, so never fabricate or mirror user feedback with learn_logic.

checkpoint_context is Runtime maintenance, not a task or memory Tool. Never decide to call it proactively. Call it only after an explicit internal user-role context_pressure instruction requires compaction, include every requested preceding Turn in the exact listed order, include an active-Turn checkpoint only when that instruction explicitly requests one, and call it alone. An active-Turn checkpoint must be cumulative through the exact requested message boundary and preserve the next action needed to continue without repeating completed side effects.

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
  /** Last session environment epoch already committed to this Session. */
  sessionEnvironmentLocalDate?: string;
  userText: string;
  userMessageName?: string;
  model: string;
  providerBinding?: RuntimeProviderBindingRef;
  tools: ToolDefinition[];
  projectDir?: string;
  workspaceDir?: string;
  projectInstructions?: string;
  files?: string[];
  images?: string[];
  attachments?: Array<{
    id: string;
    name: string;
    type: "image" | "video" | "audio" | "document" | "folder";
    path?: string;
    size?: number;
  }>;
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

function createBaseProductAgentTurnRequest(
  input: ProductAgentTurnInput,
): RuntimeSessionTurnRequest {
  const projectDir = input.projectDir?.trim() ?? "";
  const workspaceDir = input.workspaceDir?.trim() || projectDir;
  const context = runtimeContext(input, workspaceDir);
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
        ...(input.attachments?.length
          ? { metadata: { attachments: input.attachments.map((item) => ({ ...item })) } }
          : {}),
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
      ...(workspaceDir && !projectDir ? {
        workspace_mode: "task",
        workspace_dir: workspaceDir,
        task_dir: workspaceDir,
        session_workspace_dir: workspaceDir,
      } : {}),
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
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(projectDir ? { projectDir } : {}),
      ...(workspaceDir && !projectDir ? {
        sessionWorkspaceDir: workspaceDir,
        taskRoots: [workspaceDir],
      } : {}),
      permissionMode: input.permissionMode,
      subagentPermissionRouting: input.subagentPermissionRouting ?? "user",
      ...(input.childAgentPolicy ? { childAgentPolicy: input.childAgentPolicy } : {}),
      mcpContext: { filesystemRoots: workspaceDir ? [workspaceDir] : [] },
      teamId: input.teamId,
      allowedSkills: input.allowedSkills ?? [],
      planEnabled: input.planEnabled,
      contextWindowTokens: input.maxContextTokens,
      subagentChildPrefixMessages: [{ role: "system", content: CHILD_AGENT_SYSTEM_PROMPT }],
    },
  });
}

/**
 * Product request shape: session-stable facts stay in the prefix while
 * append-only Turn and environment facts are committed as internal inputs.
 */
export function createProductAgentTurnRequest(
  input: ProductAgentTurnInput,
): RuntimeSessionTurnRequest {
  const request = createBaseProductAgentTurnRequest(input);
  const projectDir = input.projectDir?.trim() ?? "";
  const workspaceDir = input.workspaceDir?.trim() || projectDir;
  const stableContext = stableRuntimeContext(input, workspaceDir);
  const turnContext = volatileTurnContext(input);
  const environmentInput = sessionEnvironmentInput(input);
  return runtimeSessionTurnRequestSchema.parse({
    ...request,
    tools: [...request.tools].sort((left, right) =>
      left.name.localeCompare(right.name) ||
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
    prefixMessages: [
      { role: "system", content: ROOT_AGENT_SYSTEM_PROMPT },
      ...(stableContext ? [{
        role: "developer" as const,
        name: "runtime_context",
        content: stableContext,
      }] : []),
    ],
    inputMessages: [
      ...(environmentInput ? [environmentInput] : []),
      ...(turnContext ? [{
        messageId: `${input.messageId}:turn-context`,
        createdAt: input.createdAt,
        message: {
          role: "user" as const,
          name: "turn_runtime_context",
          visibility: "internal" as const,
          content: turnContext,
        },
      }] : []),
      ...request.inputMessages,
    ],
    metadata: {
      ...request.metadata,
      sessionEnvironmentProtocol: BUSH_SESSION_ENVIRONMENT_PROTOCOL,
      sessionEnvironmentLocalDate: input.localDate,
    },
  });
}

function runtimeContext(input: ProductAgentTurnInput, workspaceDir: string): string {
  const content = [
    workspaceDir ? `Workspace: ${workspaceDir}` : "",
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

function stableRuntimeContext(input: ProductAgentTurnInput, workspaceDir: string): string {
  const content = [
    workspaceDir ? `Workspace: ${workspaceDir}` : "",
    input.projectInstructions?.trim()
      ? `Project instructions:\n${input.projectInstructions.trim()}`
      : "",
    input.filesystemLocations?.length
      ? `Filesystem locations:\n${[...input.filesystemLocations]
        .sort((left, right) =>
          left.id.localeCompare(right.id) ||
          left.name.localeCompare(right.name) ||
          left.path.localeCompare(right.path),
        )
        .map((location) => `${location.name}: ${location.path}`)
        .join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
  return content ? `<runtime_context>\n${content}\n</runtime_context>` : "";
}

function volatileTurnContext(input: ProductAgentTurnInput): string {
  const content = input.files?.length
    ? `Attached files:\n${input.files.join("\n")}`
    : "";
  return content ? `<turn_runtime_context>\n${content}\n</turn_runtime_context>` : "";
}

function sessionEnvironmentInput(
  input: ProductAgentTurnInput,
): RuntimeSessionTurnRequest["inputMessages"][number] | undefined {
  const previousLocalDate = input.sessionEnvironmentLocalDate?.trim() ?? "";
  if (previousLocalDate === input.localDate) return undefined;
  const kind = previousLocalDate ? "update" as const : "snapshot" as const;
  return {
    messageId: `${input.messageId}:session-environment`,
    createdAt: input.createdAt,
    message: {
      role: "user",
      name: kind === "snapshot" ? "session_environment" : "session_environment_update",
      visibility: "internal",
      content: encodeSessionEnvironmentFact({
        protocol: BUSH_SESSION_ENVIRONMENT_PROTOCOL,
        kind,
        localDate: input.localDate,
        effectiveAt: input.createdAt,
      }),
    },
  };
}

export function latestSessionEnvironmentLocalDate(
  session: Pick<SessionSnapshot, "turns"> | undefined,
): string | undefined {
  if (!session) return undefined;
  for (let turnIndex = session.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const messages = session.turns[turnIndex]?.messages ?? [];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]?.message;
      if (
        message?.role !== "user" ||
        message.visibility !== "internal" ||
        (message.name !== "session_environment" && message.name !== "session_environment_update")
      ) {
        continue;
      }
      try {
        return decodeSessionEnvironmentFact(message.content).localDate;
      } catch {
        // A malformed candidate has no authority; continue to the previous valid epoch.
      }
    }
  }
  return undefined;
}

function initialTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}
