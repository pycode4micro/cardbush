import { randomUUID } from "node:crypto";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type ModelMessage,
  type SubagentTask,
  type TeamDefinition,
  type TeamMember,
  type ToolResult,
} from "@cardbush/bush-protocol";

import {
  buildChildTurnRequest,
  inheritedChildMessages,
  resolveChildTurn,
  type ChildTurnRunner,
} from "./childTurn.js";
import type { SubagentTaskStore } from "./subagentTaskStore.js";
import type { TeamSnapshotStore } from "./teamSnapshotStore.js";
import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export const TEAM_DELEGATE_TOOL = "team_delegate" as const;

interface TeamAssignment {
  memberId: string;
  prompt: string;
}

interface TeamDelegateInput {
  teamId: string;
  sharedBrief: string;
  assignments: TeamAssignment[];
  inheritContext: boolean;
}

interface PhaseResult {
  assignment: TeamAssignment;
  member: TeamMember;
  task: SubagentTask;
}

export function registerTeamTool(
  registry: ToolRegistry,
  teams: TeamSnapshotStore,
  tasks: SubagentTaskStore,
  runChild: ChildTurnRunner,
  options: {
    createTaskId?: () => string;
    createRequestId?: () => string;
    createSessionId?: () => string;
    createTurnId?: () => string;
    createMessageId?: () => string;
    createReceiptId?: () => string;
  } = {},
): void {
  if (registry.resolve(TEAM_DELEGATE_TOOL)) return;
  const createTaskId = options.createTaskId ?? (() => `team_task_${randomUUID()}`);
  const createRequestId = options.createRequestId ?? (() => `team_request_${randomUUID()}`);
  const createSessionId = options.createSessionId ?? (() => `team_session_${randomUUID()}`);
  const createTurnId = options.createTurnId ?? (() => `team_turn_${randomUUID()}`);
  const createMessageId = options.createMessageId ?? (() => `team_message_${randomUUID()}`);
  const createReceiptId = options.createReceiptId ?? (() => `receipt_${randomUUID()}`);

  registry.register<TeamDelegateInput>({
    definition: {
      name: TEAM_DELEGATE_TOOL,
      description:
        "Dispatch explicit assignments to members of a product-configured Team. The Runtime follows the Team's configured conference phase exactly, freezes its transcript, then runs member assignments concurrently; it does not infer roles, dependencies or task semantics.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["team_id", "shared_brief", "assignments"],
        properties: {
          team_id: { type: "string", minLength: 1 },
          shared_brief: { type: "string", minLength: 1 },
          assignments: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["member_id", "prompt"],
              properties: {
                member_id: { type: "string", minLength: 1 },
                prompt: { type: "string", minLength: 1 },
              },
            },
          },
          inherit_context: { type: "boolean", default: true },
        },
      },
    },
    manifest: {
      effect_kind: "delegation",
      operation: "agent.team_delegate",
      risk: "low",
      owner: "runtime_team",
      dispatch_phase: "execution",
      dispatch_scope: "child_session",
      dispatch_side_effect: "delegated_execution",
      dispatch_mutating: true,
      dispatch_source: "product_team_snapshot",
      stage_modes: ["execute"],
      output_kinds: ["structured_data", "user_guidance"],
      handoff_exports: ["terminal_response"],
      evidence_hints: ["team_task"],
    },
    parallelSafe: false,
    visibleToChild: false,
    decodeInput,
    execute: async (context) => {
      if (!context.turn) throw new Error("Team dispatch requires the parent Turn context.");
      const team = teams.team(context.input.teamId);
      if (!team) throw new Error(`Team ${context.input.teamId} is not configured.`);
      const assignments = resolveAssignments(team, context.input.assignments);
      const inherited = inheritedChildMessages(context, context.input.inheritContext);

      let transcript: ReadonlyArray<{ memberId: string; response: string }> = [];
      let discussion: PhaseResult[] = [];
      if (team.conference.enabled) {
        discussion = await Promise.all(assignments.map(({ assignment, member }) =>
          runPhase({
            context,
            registry,
            tasks,
            runChild,
            team,
            member,
            assignment,
            phase: "discussion",
            inherited,
            prompt: discussionPrompt(team, context.input.sharedBrief, assignment),
            toolNames: [],
            ids: { createTaskId, createRequestId, createSessionId, createTurnId, createMessageId },
          })
        ));
        const failed = discussion.find(({ task }) => task.status !== "completed");
        if (failed) return toolResult(context, team, discussion, [], createReceiptId());
        transcript = Object.freeze(discussion.map(({ member, task }) => Object.freeze({
          memberId: member.memberId,
          response: task.finalResponse,
        })));
      }

      const execution = await Promise.all(assignments.map(({ assignment, member }) =>
        runPhase({
          context,
          registry,
          tasks,
          runChild,
          team,
          member,
          assignment,
          phase: "execution",
          inherited,
          prompt: executionPrompt(context.input.sharedBrief, assignment, transcript),
          toolNames: member.toolNames,
          ids: { createTaskId, createRequestId, createSessionId, createTurnId, createMessageId },
        })
      ));
      return toolResult(context, team, discussion, execution, createReceiptId());
    },
  });
}

async function runPhase(input: {
  context: ToolHandlerContext<TeamDelegateInput>;
  registry: ToolRegistry;
  tasks: SubagentTaskStore;
  runChild: ChildTurnRunner;
  team: TeamDefinition;
  member: TeamMember;
  assignment: TeamAssignment;
  phase: "discussion" | "execution";
  inherited: ModelMessage[];
  prompt: string;
  toolNames: string[];
  ids: {
    createTaskId: () => string;
    createRequestId: () => string;
    createSessionId: () => string;
    createTurnId: () => string;
    createMessageId: () => string;
  };
}): Promise<PhaseResult> {
  const taskId = input.ids.createTaskId();
  const childSessionId = input.ids.createSessionId();
  const childTurnId = input.ids.createTurnId();
  input.tasks.start({
    taskId,
    parentSessionId: input.context.sessionId,
    parentTurnId: input.context.turnId,
    childSessionId,
    childTurnId,
    prompt: input.assignment.prompt,
    inheritContext: input.context.input.inheritContext,
    inheritedMessageCount: input.inherited.length,
    origin: "team",
    teamId: input.team.teamId,
    teamMemberId: input.member.memberId,
    phase: input.phase,
  });
  let status: "completed" | "failed" | "stopped" = "failed";
  let finalResponse = "";
  let errorMessage = "";
  let usage: SubagentTask["usage"] = {};
  try {
    const request = buildChildTurnRequest({
      context: input.context,
      registry: input.registry,
      ids: {
        requestId: input.ids.createRequestId(),
        sessionId: childSessionId,
        turnId: childTurnId,
        messageId: input.ids.createMessageId(),
      },
      prompt: input.prompt,
      inherited: input.inherited,
      additionalPrefixMessages: [memberMessage(input.team, input.member, input.phase)],
      allowedToolNames: input.toolNames,
      toolChoice: input.toolNames.length > 0 ? "auto" : "none",
      metadata: {
        teamId: input.team.teamId,
        teamMemberId: input.member.memberId,
        teamPhase: input.phase,
        teamTaskId: taskId,
      },
    });
    ({ status, finalResponse, errorMessage, usage } = resolveChildTurn(
      await input.runChild(request, input.context.signal),
      childTurnId,
    ));
  } catch (error) {
    status = input.context.signal?.aborted ? "stopped" : "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const task = input.tasks.finish({
    parentSessionId: input.context.sessionId,
    taskId,
    status,
    finalResponse,
    errorMessage,
    usage,
  });
  return { assignment: input.assignment, member: input.member, task };
}

function memberMessage(
  team: TeamDefinition,
  member: TeamMember,
  phase: "discussion" | "execution",
): ModelMessage {
  return {
    role: "developer",
    name: "team_member_contract",
    content: [
      `Team: ${team.name} (${team.teamId}).`,
      `Member: ${member.name} (${member.memberId}).`,
      `Role: ${member.role}.`,
      team.instructions,
      member.instructions,
      phase === "discussion" ? team.conference.instructions : "",
    ].filter(Boolean).join("\n"),
  };
}

function discussionPrompt(
  team: TeamDefinition,
  sharedBrief: string,
  assignment: TeamAssignment,
): string {
  return [
    "This is the configured Team discussion phase. Do not execute Tools or mutate external state.",
    `Shared brief:\n${sharedBrief}`,
    `Your assignment:\n${assignment.prompt}`,
    team.conference.instructions,
    "Return a concise proposal, relevant evidence, dependencies and conflicts for the other members.",
  ].filter(Boolean).join("\n\n");
}

function executionPrompt(
  sharedBrief: string,
  assignment: TeamAssignment,
  transcript: ReadonlyArray<{ memberId: string; response: string }>,
): string {
  return [
    `Shared brief:\n${sharedBrief}`,
    `Your assignment:\n${assignment.prompt}`,
    transcript.length > 0
      ? `Frozen Team discussion transcript (identical for every member):\n${JSON.stringify(transcript)}`
      : "",
    "Execute only your assigned scope. Return the completed result, verification, risks, and absolute paths for local deliverables.",
  ].filter(Boolean).join("\n\n");
}

function resolveAssignments(team: TeamDefinition, assignments: TeamAssignment[]) {
  const seen = new Set<string>();
  return assignments.map((assignment) => {
    if (seen.has(assignment.memberId)) {
      throw new Error(`Team member ${assignment.memberId} was assigned more than once.`);
    }
    seen.add(assignment.memberId);
    const member = team.members.find((candidate) => candidate.memberId === assignment.memberId);
    if (!member) throw new Error(`Team member ${assignment.memberId} is not configured.`);
    return { assignment, member };
  });
}

function toolResult(
  context: ToolHandlerContext<TeamDelegateInput>,
  team: TeamDefinition,
  discussion: PhaseResult[],
  execution: PhaseResult[],
  receiptId: string,
): ToolResult {
  const tasks = [...discussion, ...execution];
  const completed = execution.length > 0 && execution.every(({ task }) => task.status === "completed");
  const error = tasks.find(({ task }) => task.status !== "completed")?.task.errorMessage ?? "";
  const members = execution.map(({ member, task }) => ({
    memberId: member.memberId,
    taskId: task.taskId,
    childSessionId: task.childSessionId,
    childTurnId: task.childTurnId,
    status: task.status,
    finalResponse: task.finalResponse,
    errorMessage: task.errorMessage,
    usage: task.usage,
  }));
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: completed,
    output: {
      teamId: team.teamId,
      conferenceEnabled: team.conference.enabled,
      discussionTaskIds: discussion.map(({ task }) => task.taskId),
      members,
    },
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: completed ? "succeeded" : "failed",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["team_task"],
      paths: [],
      execution_success: true,
      semantic_success: completed,
      verification_state: completed ? "verified" : "failed",
      error_code: completed ? "" : error || "team_task_failed",
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: members
      .filter((member) => member.finalResponse)
      .map((member) => ({
        role: "user" as const,
        name: `team_result_${member.memberId}`,
        content: member.finalResponse,
      })),
    ...(completed ? {} : {
      error: {
        code: "team_task_failed",
        message: error || "A configured Team phase did not complete.",
        details: { teamId: team.teamId },
      },
    }),
  };
}

function decodeInput(input: unknown): TeamDelegateInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("team_delegate input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unexpected = Object.keys(object).filter(
    (key) => !["team_id", "shared_brief", "assignments", "inherit_context"].includes(key),
  );
  if (unexpected.length > 0) throw new Error(`unsupported team_delegate arguments: ${unexpected.join(", ")}`);
  const teamId = typeof object.team_id === "string" ? object.team_id.trim() : "";
  const sharedBrief = typeof object.shared_brief === "string" ? object.shared_brief.trim() : "";
  if (!teamId) throw new Error("team_id is required.");
  if (!sharedBrief) throw new Error("shared_brief is required.");
  if (!Array.isArray(object.assignments) || object.assignments.length === 0) {
    throw new Error("assignments must be a non-empty array.");
  }
  const assignments = object.assignments.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("each Team assignment must be an object.");
    }
    const value = candidate as Record<string, unknown>;
    const keys = Object.keys(value).filter((key) => key !== "member_id" && key !== "prompt");
    if (keys.length > 0) throw new Error(`unsupported Team assignment arguments: ${keys.join(", ")}`);
    const memberId = typeof value.member_id === "string" ? value.member_id.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    if (!memberId || !prompt) throw new Error("member_id and prompt are required.");
    return { memberId, prompt };
  });
  if (object.inherit_context !== undefined && typeof object.inherit_context !== "boolean") {
    throw new Error("inherit_context must be a boolean.");
  }
  return { teamId, sharedBrief, assignments, inheritContext: object.inherit_context !== false };
}
