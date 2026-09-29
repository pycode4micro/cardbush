import type { RuntimeSessionTurnRequest, SessionSnapshot, SessionMessage } from '@cardbush/bush-protocol';
import { CHILD_AGENT_ASSIGNMENT_PREFIX } from './childAgentPolicy.js';

/** A human continuation stays in the child identity and its original execution boundary. */
export function continueChildConversation(input: RuntimeSessionTurnRequest, saved: RuntimeSessionTurnRequest): RuntimeSessionTurnRequest {
  if (saved.sessionId !== input.sessionId || saved.metadata.agentRole !== 'child') throw new Error('The original child execution configuration is unavailable.');
  const originalTools = new Set(saved.tools.map(tool => tool.name));
  const levels = ['task_free', 'user_free', 'all_free'];
  return { ...saved, requestId: input.requestId, turnId: input.turnId,
    model: input.model, providerBinding: input.providerBinding, reasoningEffort: input.reasoningEffort,
    inputMessages: input.inputMessages.map(entry => ({ ...entry, metadata: { ...entry.metadata, subagentAuthor: 'user' } })),
    supersession: input.supersession,
    tools: input.tools.filter(tool => originalTools.has(tool.name)),
    permissionMode: levels[Math.min(levels.indexOf(saved.permissionMode), levels.indexOf(input.permissionMode))] as RuntimeSessionTurnRequest['permissionMode'],
    sessionMetadata: { ...saved.sessionMetadata, agentRole: 'child' },
    metadata: { ...saved.metadata, individuation: input.metadata.individuation, subagentUserContinuation: true,
      // A human follow-up belongs to this new turn; never publish approval events
      // into the original (possibly already terminal) parent turn.
      permissionRouting: 'user', permissionScopeSessionId: input.sessionId,
      permissionEventRequestId: input.requestId, permissionEventSessionId: input.sessionId, permissionEventTurnId: input.turnId,
      disabledTools: [...new Set([...(saved.metadata.disabledTools as string[] ?? []), ...(input.metadata.disabledTools as string[] ?? [])])],
      disabledSkills: [...new Set([...(saved.metadata.disabledSkills as string[] ?? []), ...(input.metadata.disabledSkills as string[] ?? [])])],
    },
  };
}

export type ChildConversationSource = { sessionId: string; messages: SessionMessage[]; supersededMessageIds: string[]; finalMessageIds: string[] };

/** Parent-facing output is one terminal answer per completed turn, never loop activity. */
export function childFinalMessageIds(session: SessionSnapshot): string[] {
  return session.turns.flatMap(turn => {
    if (turn.status !== 'completed') return [];
    const last = [...turn.messages].reverse().find(entry => entry.message.role === 'assistant' && entry.metadata?.runtimeMaintenance !== 'context_compaction');
    return last?.message.role === 'assistant' && !last.message.toolCalls.length && last.message.content.trim() ? [last.messageId] : [];
  });
}
export function childConversationPage(session: SessionSnapshot | ChildConversationSource | undefined, cursor = '0:0') {
  if (!/^\d+:\d+$/.test(cursor)) throw new Error('Invalid conversation cursor.');
  let [index, offset] = cursor.split(':').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset)) throw new Error('Invalid conversation cursor.');
  const hidden = new Set(session?.supersededMessageIds ?? []);
  const finals = new Set(session ? ('turns' in session ? childFinalMessageIds(session) : session.finalMessageIds) : []);
  const source = (session ? ('turns' in session ? session.turns.flatMap(turn => turn.messages) : session.messages) : []).filter(entry =>
    !hidden.has(entry.messageId) && (entry.message.role === 'user' || (entry.message.role === 'assistant' && finals.has(entry.messageId))) &&
    !(entry.message.role === 'user' && (entry.message.visibility === 'internal' || entry.message.name === 'subagent_result')) &&
    entry.metadata?.runtimeMaintenance !== 'context_compaction') ?? [];
  const messages = [];
  let budget = 16000;
  while (index < source.length && budget > 0 && messages.length < 40) {
    const entry = source[index];
    const legacyAssignment = entry.message.role === 'user' && entry.message.content.startsWith(CHILD_AGENT_ASSIGNMENT_PREFIX + '\n');
    const content = legacyAssignment ? entry.message.content.slice(CHILD_AGENT_ASSIGNMENT_PREFIX.length).trimStart() : entry.message.content;
    const part = content.slice(offset, offset + budget);
    messages.push({ messageId: entry.messageId, turnId: entry.turnId, role: entry.message.role,
      author: entry.message.role === 'user' ? (entry.metadata?.subagentAuthor === 'parent' || legacyAssignment ? 'parent_agent' : 'user') : 'child_agent',
      createdAt: entry.createdAt, content: part, contentOffset: offset, complete: offset + part.length >= content.length,
    });
    budget -= part.length;
    if (offset + part.length < content.length) { offset += part.length; break; }
    index++; offset = 0;
  }
  return { sessionId: session?.sessionId, messages, nextCursor: index < source.length ? `${index}:${offset}` : null };
}
