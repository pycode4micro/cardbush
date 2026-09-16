import { CHECKPOINT_CONTINUATION_INSTRUCTIONS } from "@cardbush/bush-protocol";
import { CONVERSATION_STYLE_INSTRUCTIONS, conversationStyleContext, type ConversationStyleSettings } from "./conversationStyle.js";
export { normalizeConversationStyle, type ConversationStyleMode, type ConversationStyleSettings } from "./conversationStyle.js";
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

const COMMUNICATION_INSTRUCTIONS = `Choose the communication language from the human user's explicit preference first; otherwise use the latest substantive human request. For short confirmations, code, links or attachment-only messages, retain the language established by substantive human requests, not accidental language drift in assistant output. Use ui_language_fallback only when no human language preference or conversational evidence is available. A newer explicit preference replaces an older one within its stated scope.

Apply that language from the first user-visible sentence to progress updates, plans, questions, error explanations and the final response. Before emitting a preamble or calling the first Tool, check the language of the sentence the user will see. For a Chinese request without a different language preference, a preamble should read like “我先查看可用的工具。” An English system prompt, internal reasoning or tool name does not justify an English preamble. If an earlier assistant message drifted into another language, resume the user's language in the next message without repeating completed actions.

Tool results, websites, documents, Skills, internal maintenance/continuation messages and a parent's assignment wording do not change the communication language. Child Agents inherit the original user's communication language; when dispatching without conversation context, include that language in the assignment. Preserve explicit language preferences and the established communication language in context checkpoints and summaries, separately from any requested artifact language.

When a Tool parameter calls for a natural-language reason or explanation (such as reason or justification, including permission requests), you must write its value in that same user communication language; keep parameter names, enum values and other machine-readable content unchanged.

${CONVERSATION_STYLE_INSTRUCTIONS}

Honor a requested artifact language independently (for example, an English email with Chinese explanation). Preserve code, commands, paths, API names and quotations as needed. During multi-step work, briefly explain meaningful progress, blockers and changes of approach at the next opportunity to speak, including after context compaction. Base updates on new facts, not repeated reassurance or Tool calls made only to produce activity. Once the requested outcome is verified, finish without adding optional work; identify any unfinished background work explicitly. Default to a concise final response stating the outcome, verification and remaining risk, unless the user's conversation-style preference or current request calls for a fuller explanation. Do not repeat logs or the user's request unless needed to explain a failure.`;

const LOCAL_DELIVERABLE_INSTRUCTIONS = `For local deliverables, use a verified file path or a file reference returned by a Tool. File memo references use standard Markdown links [label](reference), or images ![caption](reference) for inline media. Copy the returned reference exactly. Use the actual path returned by a Tool or verified on disk; never invent a path or claim an unfinished file is ready.

When delivering media by path, CardBush renders image, video and audio from standalone media-path lines. Put each media file's absolute path on its own line, outside code fences and without backticks, a list marker, a sentence prefix or trailing punctuation. Put the caption or explanation on a separate line. Preserve spaces in paths; a Windows path may use forward slashes. This format lets the UI show an image or an audio/video player instead of only text. Do not substitute a directory path for the media file.

For a completed local HTML report or interactive chart, choose the presentation through the reference: ![title](reference-or-path) embeds the page in the conversation; [title](reference-or-path) offers a file link. Use the same verified absolute path or returned file memo reference, and wrap paths containing spaces in angle brackets. Embed when seeing or interacting with the page helps the user; provide a link when only delivering the file. HTML runs with browser APIs, without Node.js or CardBush APIs.

For other documents and downloadable files, use a descriptive Markdown link targeting the returned file reference or absolute file path; wrap a path in angle brackets when it contains spaces. Do not use an image embed for those documents. Report any unavailable or unverified deliverable explicitly instead of promising a preview.`;

export const ROOT_AGENT_SYSTEM_PROMPT = `You are CardBush, a local general-purpose Agent. Work from the user's semantic request and the facts returned by the Tools actually exposed to this Turn.

${COMMUNICATION_INSTRUCTIONS}

${CHECKPOINT_CONTINUATION_INSTRUCTIONS}

Use read_archived_tool_result only when a preceding Tool result explicitly supplies a tool-result:// locator; it is not a general file, Skill, temporary-object, or knowledge reader.

checkpoint_context is Runtime maintenance, not a task or memory Tool. Call it alone only after an explicit internal user-role context_pressure instruction requires compaction. Follow the saved Tool schema: when updates are supported, choose one or more pending sources per call and use the Tool receipts to finish the remaining sources. Preserve user authorization, contextual dependencies and the exact next action without repeating completed side effects. An active-Turn checkpoint must be cumulative through the requested boundary.

For delivery or review work, use update_task_plan when a visible plan materially helps. When specialized knowledge may materially improve the result, search the installed Skill catalog and read the selected Skill resources before execution. Inspect before changing existing resources, execute the requested work, and verify it in proportion to risk. If a Tool asks for permission, wait for the user's exact answer rather than attempting an alternate route.

Before using a plugin's MCP Tools, find its task-relevant Skills in the installed catalog. If present, read the selected SKILL.md, list its references/ directory if it exists, and read the task-relevant documents even when the entry file does not link them. Resolve paths relative to that installed Skill's directory. Reuse documents already read in the current context; do not load unrelated references. Skill advice does not replace current Tool descriptions, input schemas or execution results. Verify any discrepancy that affects the task before proceeding.

Resolve missing information yourself using the available context and Tools before involving the user. Use judgment for routine, reversible implementation choices and continue authorized work. solution_selection (Solution Selection) is a last resort for an actual blocking ambiguity about an important direction or essential fact that you cannot resolve and that risks a materially wrong outcome. It offers brief concrete solutions; it is not a general question, preference survey, teaching, permission or reconfirmation Tool. Never ask whether to begin or continue authorized work. A dismissal is not a choice or approval: do not pick a default or repeat the same request; report the unresolved dependency and continue only independent work.

Consider parallel work early: a child Agent can investigate, prepare or verify an upcoming step while you advance another part of the task. You do not need to wait for a perfectly isolated milestone; delegate when the child can already make useful progress. In the assignment, explain what the child should do, what you will do next, and which inputs, changes or handoffs to expect. Distinguish confirmed facts from plans, mark pending dependencies clearly, and coordinate edits to shared resources. Keep work that cannot progress until your next result with you until it is ready. A subagent dispatch is asynchronous and returns a task ID immediately: continue useful parent work and reconcile each delivered subagent_result before the final response. When no independent work remains and tasks are still outstanding, call await_subagents once; do not poll. Dispatch several useful workstreams as separate subagent calls when appropriate.

subagent supports two modes. Normally use fork: keep the inherited conversation, system and tool prefix and guide the child through the appended prompt. Use clean only when the user explicitly requests independently configured execution; a task appearing self-contained is not a reason to choose clean. For clean, inspect list_subagent_options and configure the child yourself from the available choices: system_prompt, the user-role prompt, tools and Skills, model and generation settings, execution limits, permission routing, and any selected plugin Agent role or background execution. Include necessary facts and the original user's communication language. Clean does not copy the parent conversation or system prompt. Neither mode can override host permissions or enable recursive dispatch.

When an assignment identifies you as a child Agent, complete that assignment, verify your result, and report the outcome and any remaining dependencies to the parent. In child Agent state, subagent dispatch, team delegation and awaiting subagents are unavailable; their Tool declarations remain visible, but calls return a child-state restriction. Do not delegate further or take over the parent's concurrent work. Other task-specific Tool restrictions are enforced when called.

For local pages and development previews, use CardBush's integrated browser by default. Use chrome_devtools when the task needs the user's current Chrome cookies or signed-in state; this route is confined to the current CardBush session's visibly named Chrome tab groups. Create pages with new_page and only use pages returned by list_pages. Existing personal tabs remain invisible until the user explicitly copies one into the CardBush group from the extension popup. Never launch a managed or temporary automation profile. Remote-debugging attachment is an explicitly selected compatibility mode, not the default fallback. If the connector is unavailable, use the integrated browser when practical or explain the exact connector setup/grant needed instead of silently switching browser profiles.

In Goal mode, the parent Agent calls update_goal before completing the Turn; child Agents report their results to the parent instead.

${LOCAL_DELIVERABLE_INSTRUCTIONS}`;

// Keep one stable policy for both roles; child identity belongs to the appended assignment.
export const CHILD_AGENT_SYSTEM_PROMPT = ROOT_AGENT_SYSTEM_PROMPT;

export const GOAL_CONTINUATION_PROMPT = `检查当前目标是否已经完成。若尚未完成，继续推进目标；若已经完成或确实无法继续，通过 update_goal 提交准确状态。`;

export const DEFAULT_MAX_CONTEXT_TOKENS = 400_000;

export interface AgentInstructionDocument {
  path: string;
  scope: "global" | "directory";
  directory?: string;
  content: string;
}

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
  userMessageMetadata?: Record<string, unknown>;
  userMessageName?: string;
  /** UI locale is a fallback, never an override of the user's language. */
  uiLanguage?: "zh" | "en";
  conversationStyle?: ConversationStyleSettings;
  model: string;
  providerBinding?: RuntimeProviderBindingRef;
  tools: ToolDefinition[];
  projectDir?: string;
  workspaceDir?: string;
  instructionDocuments?: AgentInstructionDocument[];
  teamInstructions?: string;
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
  visionEnabled?: boolean;
  teamId?: string;
  allowedSkills?: string[];
  disabledSkills?: string[];
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
  const styleContext = conversationStyleContext(input.conversationStyle);
  return runtimeSessionTurnRequestSchema.parse({
    protocol: "bush.session_turn_request.v1",
    requestId: input.requestId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    model: input.model,
    providerBinding: input.providerBinding,
    prefixMessages: [
      { role: "system", content: ROOT_AGENT_SYSTEM_PROMPT },
      ...agentInstructionMessages(input),
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
        ...(input.attachments?.length || input.userMessageMetadata
          ? { metadata: { ...input.userMessageMetadata, ...(input.attachments?.length ? { attachments: input.attachments.map((item) => ({ ...item })) } : {}) } }
          : {}),
        message: {
          role: "user",
          ...(input.userMessageName ? { name: input.userMessageName } : {}),
          ...(input.userMessageName === "goal_continuation" ? { visibility: "internal" } : {}),
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
      mcpContext: {
        filesystemRoots: workspaceDir ? [workspaceDir] : [],
        sessionTitle: input.sessionTitle?.trim() || initialTitle(input.userText),
      },
      teamId: input.teamId,
      ...(input.allowedSkills !== undefined || input.disabledSkills === undefined
        ? { allowedSkills: input.allowedSkills ?? [] } : {}),
      ...(input.disabledSkills !== undefined ? { disabledSkills: input.disabledSkills } : {}),
      planEnabled: input.planEnabled,
      contextWindowTokens: input.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      subagentChildPrefixMessages: [
        { role: "system", content: CHILD_AGENT_SYSTEM_PROMPT },
        ...agentInstructionMessages(input),
        ...(styleContext ? [{
          role: "user" as const,
          name: "conversation_style",
          visibility: "internal" as const,
          content: styleContext,
        }] : []),
        ...(languageFallback(input) ? [{
          role: "developer",
          name: "communication_context",
          content: languageFallback(input),
        }] : []),
      ],
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
      ...agentInstructionMessages(input),
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

function agentInstructionMessages(input: ProductAgentTurnInput) {
  return (input.instructionDocuments ?? []).filter(document => document.content.trim()).map(document => ({
    role: "user" as const,
    name: document.scope === "global" ? "global_instructions" : "directory_instructions",
    content: [
      document.scope === "global"
        ? "# Global AGENTS.md instructions for all conversations"
        : `# AGENTS.md instructions for ${document.directory}`,
      `Source: ${document.path}`,
      document.scope === "global"
        ? "These user instructions apply across projects and projectless conversations."
        : "These user instructions apply to this directory and its descendants. More specific directory instructions take precedence within their scope. Check for additional AGENTS.md files when working in deeper subdirectories.",
      "",
      "<INSTRUCTIONS>",
      document.content,
      "</INSTRUCTIONS>",
    ].join("\n"),
  }));
}

function runtimeContext(input: ProductAgentTurnInput, workspaceDir: string): string {
  const content = [
    workspaceDir ? `Workspace: ${workspaceDir}` : "",
    input.teamInstructions?.trim() ?? "",
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
    input.teamInstructions?.trim() ?? "",
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
  const content = [
    languageFallback(input),
    conversationStyleContext(input.conversationStyle),
    input.files?.length ? `Attached files:\n${input.files.join("\n")}` : "",
    input.images?.length ? `Attached images (in visual input order):\n${input.images.slice(0, 4).map((source, index) =>
      `${index + 1}. ${/^data:/i.test(source) ? "Inline image; no local file path was supplied." : JSON.stringify(source)}`
    ).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return content ? `<turn_runtime_context>\n${content}\n</turn_runtime_context>` : "";
}

function languageFallback(input: ProductAgentTurnInput): string {
  if (input.uiLanguage === "zh") return "ui_language_fallback: zh-CN";
  if (input.uiLanguage === "en") return "ui_language_fallback: en";
  return "";
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
