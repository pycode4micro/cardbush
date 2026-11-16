import { z } from 'zod';
import { teamSubmissionSchema, childExecutionFactsSchema, type TeamSubmission, type ChildExecutionFacts, type SessionSnapshot } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';

const protocol = 'bush.team_submission.v1';
type Turn = SessionSnapshot['turns'][number];

export function registerTeamSubmission(registry: ToolRegistry) {
  if (registry.resolve('team_submit')) return;
  registry.register<TeamSubmission>({
    definition: { name: 'team_submit',
      description: 'Explicitly declare your own child assignment submitted or blocked. Only your current attempt is affected. Include artifact references and your own checks if useful. This records your judgment; the host does not inspect files, infer quality or verify the claims. A reviewer is another Agent node with its own assignment and submission. Ending a reply alone does not submit a Team node.',
      inputSchema: structuredClone(z.toJSONSchema(teamSubmissionSchema, { io: 'input' })) },
    manifest: { effect_kind: 'read_only', operation: 'agent.team.submit', risk: 'low', owner: 'runtime', dispatch_scope: 'turn', mutating: false },
    visibleToChild: true, parallelSafe: false,
    decodeInput: value => teamSubmissionSchema.parse(value),
    execute: context => {
      if (context.turn?.request.metadata.agentRole !== 'child') throw Object.assign(Error('Only a child Agent can submit its own assignment.'), { code: 'team_submission_scope' });
      context.signal?.throwIfAborted();
      return { protocol, sessionId: context.sessionId, turnId: context.turnId, submission: context.input };
    },
  });
}

/** Only successful native receipts from this exact child turn are declarations.
 * Prose, remembered history and other tools cannot impersonate a submission. */
export function childSubmission(turn: { turnId: string; messages: Array<Pick<Turn['messages'][number], 'message'>> } | undefined, sessionId: string): TeamSubmission | undefined {
  if (!turn) return undefined;
  const calls = new Set<string>();
  let submission: TeamSubmission | undefined;
  for (const { message } of turn.messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) {
      let target = call.name;
      try { if (target === 'call_tool') target = JSON.parse(call.argumentsText).name; } catch { continue; }
      if (target === 'team_submit') calls.add(call.id);
    }
    if (message.role !== 'tool' || !calls.delete(message.toolCallId)) continue;
    try {
      const value = JSON.parse(message.content);
      if (value.protocol === protocol && value.sessionId === sessionId && value.turnId === turn.turnId)
        submission = teamSubmissionSchema.parse(value.submission);
    } catch { /* A failed or malformed invocation is not a declaration. */ }
  }
  return submission;
}

/** Execution facts only: no prompts, credentials, tool arguments or private reasoning. */
export function childExecutionFacts(turn: Turn | undefined): ChildExecutionFacts | undefined {
  if (!turn) return undefined;
  const facts = childExecutionFactsSchema.safeParse({ turnId: turn.turnId, status: turn.status, reason: turn.reason,
    startedAt: turn.createdAt, completedAt: turn.completedAt,
    toolCalls: turn.messages.reduce((count, { message }) => count + (message.role === 'assistant' ? message.toolCalls?.length ?? 0 : 0), 0),
    toolReceipts: turn.messages.filter(({ message }) => message.role === 'tool').length,
    ...(turn.usage?.lastRequestInputTokens !== undefined ? { inputTokens: turn.usage.lastRequestInputTokens } : {}),
    ...(turn.usage?.lastRequestOutputTokens !== undefined ? { outputTokens: turn.usage.lastRequestOutputTokens } : {}) });
  return facts.success ? facts.data : undefined;
}
