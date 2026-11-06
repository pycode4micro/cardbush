import { renderPromptTemplate } from '@cardbush/platform/prompts';
import { CHECKPOINT_CONTINUATION_INSTRUCTIONS, DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, collectTurnAttachments, formatTurnAttachmentContext } from "@cardbush/bush-protocol";
import { REPORT_DELIVERY_INSTRUCTIONS, TASK_CONTINUATION_INSTRUCTIONS, SOURCE_BINDING_INSTRUCTIONS } from '@cardbush/bush-protocol';
import { FINAL_RESPONSE_SIGNAL_INSTRUCTIONS, individuationPreferenceText, normalizeIndividuation, type IndividuationSettings } from '@cardbush/bush-protocol';
import { createTurnTimeContext } from "@cardbush/bush-protocol";
export { createTurnTimeContext } from "@cardbush/bush-protocol";
import { CONVERSATION_STYLE_INSTRUCTIONS, conversationStyleContext, type ConversationStyleSettings } from "./conversationStyle.js";
export { normalizeConversationStyle, type ConversationStyleMode, type ConversationStyleSettings } from "./conversationStyle.js";
import {
  runtimeSessionTurnRequestSchema,
  type ReasoningEffort,
  type RuntimeProviderBindingRef,
  type RuntimeSessionTurnRequest,
  type ToolDefinition,
} from "@cardbush/bush-protocol";

const COMMUNICATION_INSTRUCTIONS = renderPromptTemplate('communication-instructions', { conversationStyleInstructions: CONVERSATION_STYLE_INSTRUCTIONS });

const LOCAL_DELIVERABLE_INSTRUCTIONS = renderPromptTemplate('local-deliverable-instructions', { reportDeliveryInstructions: REPORT_DELIVERY_INSTRUCTIONS });

export const ROOT_AGENT_SYSTEM_PROMPT = renderPromptTemplate('root-agent-system-prompt', { communicationInstructions: COMMUNICATION_INSTRUCTIONS, checkpointContinuationInstructions: CHECKPOINT_CONTINUATION_INSTRUCTIONS, finalResponseSignalInstructions: FINAL_RESPONSE_SIGNAL_INSTRUCTIONS, localDeliverableInstructions: LOCAL_DELIVERABLE_INSTRUCTIONS });

// Keep one stable policy for both roles; child identity belongs to the appended assignment.
export const CHILD_AGENT_SYSTEM_PROMPT = ROOT_AGENT_SYSTEM_PROMPT;

export const GOAL_CONTINUATION_PROMPT = renderPromptTemplate('goal-continuation-prompt');

export { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '@cardbush/bush-protocol';

export function sourcePreferenceText(enabled = true): string {
  return enabled
    ? renderPromptTemplate('source-enabled')
    : renderPromptTemplate('source-disabled');
}

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
  /** User-device zone; remote callers may also supply userMessageMetadata.userTimeZone. */
  timeZone?: string;
  userText: string;
  userMessageMetadata?: Record<string, unknown>;
  userMessageName?: string;
  /** UI locale is a fallback, never an override of the user's language. */
  uiLanguage?: string;
  conversationStyle?: ConversationStyleSettings;
  sourceEnabled?: boolean;
  individuation?: IndividuationSettings;
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
  const attachments = collectTurnAttachments({ messageId: input.messageId,
    attachments: input.attachments ?? input.userMessageMetadata?.attachments,
    files: input.files, images: input.images?.slice(0, 4) });
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
        metadata: { ...input.userMessageMetadata, sourceEnabled: input.sourceEnabled !== false,
          ...(attachments.length ? { attachments } : {}) },
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
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    reasoningEffort: input.reasoningEffort,
    requestCapabilities: {
      vision: input.visionEnabled === true,
      interactiveRequests: input.interactiveRequestsEnabled === true,
    },
    permissionMode: input.permissionMode,
    metadata: {
      source: "cardbush_product_agent",
      environmentContext: true,
      systemPolicy: { id: 'cardbush.product', version: '10' },
      mcpCatalogUpdates: 'additions',
      individuation: normalizeIndividuation(input.individuation),
      ...(input.uiLanguage ? { uiLanguage: input.uiLanguage } : {}),
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
      // Omitted filters use the installed catalog. An explicit empty allowlist
      // still disables Skills for restricted callers.
      ...(input.allowedSkills !== undefined ? { allowedSkills: input.allowedSkills } : {}),
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
 * append-only preferences, time snapshots and attachment facts are internal inputs.
 */
export function createProductAgentTurnRequest(
  input: ProductAgentTurnInput,
): RuntimeSessionTurnRequest {
  const request = createBaseProductAgentTurnRequest(input);
  const projectDir = input.projectDir?.trim() ?? "";
  const workspaceDir = input.workspaceDir?.trim() || projectDir;
  const stableContext = stableRuntimeContext(input, workspaceDir);
  const timeContext = createTurnTimeContext({ createdAt: input.createdAt, timeZone: input.timeZone ?? input.userMessageMetadata?.userTimeZone });
  const turnContext = formatTurnAttachmentContext(timeContext,
    collectTurnAttachments({ messageId: input.messageId, attachments: request.inputMessages[0].metadata?.attachments, preserveImageIndexes: true }));
  const preferences = [languageFallback(input), conversationStyleContext(input.conversationStyle)].filter(Boolean).join("\n");
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
      ...(preferences ? [{
        messageId: `${input.messageId}:conversation-preferences`,
        createdAt: input.createdAt,
        message: {
          role: "user" as const,
          name: "conversation_preferences",
          visibility: "internal" as const,
          content: preferences,
        },
      }] : []),
      ...(turnContext ? [{
        messageId: `${input.messageId}:turn-context`,
        createdAt: input.createdAt,
        metadata: { attachmentContext: { messageId: input.messageId, timeContext } },
        message: {
          role: "user" as const,
          name: "turn_runtime_context",
          visibility: "internal" as const,
          content: turnContext,
        },
      }] : []),
      { messageId: `${input.messageId}:source-preference`, createdAt: input.createdAt,
        message: { role: 'user' as const, name: 'source_preference', visibility: 'internal' as const,
          content: sourcePreferenceText(input.sourceEnabled !== false) } },
      { messageId: `${input.messageId}:individuation-preference`, createdAt: input.createdAt,
        message: { role: 'user' as const, name: 'individuation_preference', visibility: 'internal' as const,
          content: individuationPreferenceText(input.individuation) } },
      // Compatible guidance is appended to the current turn. Existing sessions
      // retain their frozen system/tool contract and need no history migration.
      { messageId: `${input.messageId}:delivery-guidance`, createdAt: input.createdAt,
        message: { role: 'user' as const, name: 'delivery_guidance', visibility: 'internal' as const,
          content: [REPORT_DELIVERY_INSTRUCTIONS, TASK_CONTINUATION_INSTRUCTIONS, SOURCE_BINDING_INSTRUCTIONS].join('\n\n') } },
      ...request.inputMessages,
    ],
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

function languageFallback(input: ProductAgentTurnInput): string {
  if (input.uiLanguage) {
    try { return `ui_language_fallback: ${new Intl.Locale(input.uiLanguage).baseName}`; }
    catch { return ""; }
  }
  return "";
}

function initialTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}
