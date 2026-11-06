import type { ModelRequest, RuntimeAgentFact, RuntimeEvent } from '@cardbush/bush-protocol';
import { normalizeIdentity } from './workspaceAccessPolicy.js';

export type AgentExecutionInput = Pick<ModelRequest, 'sessionId' | 'turnId' | 'metadata'> & {
  sessionMetadata?: Record<string, unknown>;
} & Partial<Pick<ModelRequest, 'permissionMode' | 'requestCapabilities'>>;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const active = (fact: RuntimeAgentFact) => ['queued', 'running', 'waiting'].includes(fact.status);

/** Live host facts, shared by every execution adapter. No prompts or tool results. */
export class AgentExecutionRegistry {
  private facts = new Map<string, RuntimeAgentFact>();
  private closed = false;
  constructor(private now: () => string = () => new Date().toISOString(), private retained = 256) {}
  private key(session: string, turn: string) { return JSON.stringify([session, turn]); }
  begin(input: AgentExecutionInput, status: RuntimeAgentFact['status'] = 'queued'): RuntimeAgentFact {
    const metadata = { ...input.sessionMetadata, ...input.metadata };
    const parentAgentId = text(metadata.parentSessionId) ?? text(metadata.delegationOwner);
    const role = metadata.agentRole === 'child' || parentAgentId ? 'child' : 'root';
    const previous = this.facts.get(this.key(input.sessionId, input.turnId));
    const now = this.now();
    const fact: RuntimeAgentFact = {
      agentId: input.sessionId, executionId: input.turnId, role,
      ...(parentAgentId ? { parentAgentId } : {}),
      projectDir: text(metadata.projectDir), workspaceDir: text(metadata.workspaceDir) ?? text(metadata.projectDir),
      status: previous && active(previous) && status === 'queued' ? previous.status : status,
      readOnly: metadata.shadowReadOnly === true || metadata.shadowMode === 'readonly' || metadata.registeredAgentReadOnly === true,
      canDelegate: role === 'root',
      permissionMode: input.permissionMode, interactiveRequests: input.requestCapabilities?.interactiveRequests,
      // Registration is unconditional. Scheduling authority is a separate policy.
      canWake: role === 'root' && !metadata.automationRunId && !metadata.pluginHookEvaluation &&
        !metadata.shadowMode && metadata.runtimeTask !== 'internal' && !metadata.personalAssistant,
      startedAt: previous?.startedAt ?? now, updatedAt: now,
    };
    if (!this.closed) this.facts.set(this.key(input.sessionId, input.turnId), fact);
    this.prune();
    return structuredClone(fact);
  }
  get(session: string, turn?: string): RuntimeAgentFact | undefined {
    const fact = turn ? this.facts.get(this.key(session, turn)) : this.list().find(item => item.agentId === session);
    return fact && structuredClone(fact);
  }
  update(session: string, turn: string, status: RuntimeAgentFact['status']) {
    const fact = this.facts.get(this.key(session, turn));
    if (!fact || fact.status === status || !active(fact)) return;
    fact.status = status; fact.updatedAt = this.now(); this.prune();
  }
  stop(session: string, turn: string) {
    const fact = this.facts.get(this.key(session, turn));
    if (fact && fact.status !== 'stopped') { fact.status = 'stopped'; fact.updatedAt = this.now(); }
  }
  observe(event: RuntimeEvent) {
    if (event.kind === 'turn_terminal') {
      this.update(event.sessionId, event.turnId, event.payload.status === 'completed' ? 'completed'
        : event.payload.status === 'stopped' ? 'stopped' : 'failed');
    } else if (['permission_requested', 'solution_selection_requested'].includes(event.kind)) {
      this.update(event.sessionId, event.turnId, 'waiting');
    } else if (['turn_started', 'model_request_started', 'tool_running', 'permission_answered', 'solution_selection_answered'].includes(event.kind)) {
      this.update(event.sessionId, event.turnId, 'running');
    }
  }
  list(): RuntimeAgentFact[] {
    const latest = new Map<string, RuntimeAgentFact>();
    for (const fact of this.facts.values()) {
      const prior = latest.get(fact.agentId);
      if (!prior || !active(prior) || active(fact)) latest.set(fact.agentId, fact);
    }
    return structuredClone([...latest.values()]);
  }
  related(session: string): RuntimeAgentFact[] {
    const all = this.list(), self = all.find(fact => fact.agentId === session);
    if (!self) return [];
    const root = (fact: RuntimeAgentFact) => {
      const seen = new Set<string>();
      while (fact.parentAgentId && !seen.has(fact.agentId)) {
        seen.add(fact.agentId);
        const parent = all.find(item => item.agentId === fact.parentAgentId);
        if (!parent) return fact.parentAgentId;
        fact = parent;
      }
      return fact.agentId;
    };
    const same = (a?: string, b?: string) => !!a && !!b && normalizeIdentity(a) === normalizeIdentity(b);
    const owner = root(self);
    return all.filter(fact => fact.agentId === session || root(fact) === owner ||
      same(self.projectDir, fact.projectDir) || same(self.workspaceDir, fact.workspaceDir));
  }
  forget(session: string) { for (const [key, fact] of this.facts) if (fact.agentId === session) this.facts.delete(key); }
  clear() { this.facts.clear(); }
  close() { this.closed = true; this.clear(); }
  private prune() {
    const inactive = [...this.facts].filter(([, fact]) => !active(fact));
    for (const [key] of inactive.slice(0, Math.max(0, inactive.length - this.retained))) this.facts.delete(key);
  }
}
