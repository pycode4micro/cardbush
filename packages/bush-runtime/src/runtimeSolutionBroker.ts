import { randomUUID } from 'node:crypto';
import { runtimeSolutionAnswerSchema, solutionSelectionInputSchema,
  type RuntimeSolutionAnswer, type RuntimeSolutionSelection, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { InMemoryRuntimeEventLog, RuntimeEventIdentity } from './runtimeEventLog.js';

type SolutionResult = { status: 'selected'; source: 'option' | 'text'; text: string }
  | { status: 'cancelled'; message: string };
interface PendingSolution {
  request: RuntimeSolutionSelection;
  identity: RuntimeEventIdentity;
  resolve: (result: SolutionResult) => void;
  detach: () => void;
}

/** Runtime-owned waits survive switching conversations or reconnecting the renderer. */
export class RuntimeSolutionBroker {
  readonly #pending = new Map<string, PendingSolution>();
  constructor(readonly eventLog: InMemoryRuntimeEventLog) {}

  list(sessionId: string): RuntimeSolutionSelection[] {
    return [...this.#pending.values()].filter(entry => entry.request.sessionId === sessionId)
      .map(entry => structuredClone(entry.request));
  }

  request(identity: RuntimeEventIdentity, toolCallId: string, candidate: SolutionSelectionInput,
    signal?: AbortSignal): Promise<SolutionResult> {
    const input = solutionSelectionInputSchema.parse(candidate);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Turn stopped.', 'AbortError'));
    // One unresolved direction at a time; simultaneous calls must not stack questionnaires.
    if (this.list(identity.sessionId).length) throw new Error('A solution selection is already pending in this session. Wait for that decision.');
    const request: RuntimeSolutionSelection = { ...input, selectionId: `solution_${randomUUID()}`,
      sessionId: identity.sessionId, turnId: identity.turnId, toolCallId, createdAt: new Date().toISOString() };
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.#pending.delete(request.selectionId)) return;
        signal?.removeEventListener('abort', abort);
        try { this.eventLog.append(identity, { kind: 'solution_selection_cancelled',
          payload: { selectionId: request.selectionId, reason: 'turn_cancelled' } }); }
        catch (error) { reject(error); return; }
        reject(new DOMException('Solution selection was cancelled with its Turn.', 'AbortError'));
      };
      this.#pending.set(request.selectionId, { request, identity, resolve,
        detach: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.eventLog.append(identity, { kind: 'solution_selection_requested', payload: request }); }
      catch (error) { this.#pending.delete(request.selectionId); signal?.removeEventListener('abort', abort); reject(error); }
    });
  }

  answer(candidate: RuntimeSolutionAnswer): RuntimeSolutionAnswer {
    const answer = runtimeSolutionAnswerSchema.parse(candidate);
    const entry = this.#pending.get(answer.selectionId);
    if (!entry) throw Object.assign(new Error('Solution selection is not pending.'), { code: 'solution_not_pending' });
    if (entry.request.sessionId !== answer.sessionId || entry.request.turnId !== answer.turnId) {
      throw new Error('Solution selection belongs to a different session or Turn.');
    }
    if (answer.kind === 'option' && answer.optionIndex >= entry.request.options.length) {
      throw new Error('The selected solution does not exist.');
    }
    this.eventLog.append(entry.identity, answer.kind === 'cancel'
      ? { kind: 'solution_selection_cancelled', payload: { selectionId: answer.selectionId, reason: 'user_cancelled' } }
      : { kind: 'solution_selection_answered', payload: answer });
    this.#pending.delete(answer.selectionId);
    entry.detach();
    entry.resolve(answer.kind === 'cancel'
      ? { status: 'cancelled', message: 'The user dismissed this decision without selecting a solution. Do not infer approval, choose a default, or repeat the same request. Leave dependent work blocked and explain what remains unresolved; continue only independent work.' }
      : { status: 'selected', source: answer.kind, text: answer.kind === 'text' ? answer.text : entry.request.options[answer.optionIndex]! });
    return answer;
  }
}
