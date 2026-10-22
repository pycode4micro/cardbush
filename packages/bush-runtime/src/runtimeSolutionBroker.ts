import { randomUUID } from 'node:crypto';
import { runtimeSolutionAnswerSchema, solutionSelectionInputSchema, solutionSelectionQuestions,
  type RuntimeSolutionAnswer, type RuntimeSolutionSelection, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { InMemoryRuntimeEventLog, RuntimeEventIdentity } from './runtimeEventLog.js';

export type SolutionResult = { status: 'selected'; source: 'option' | 'text'; text: string }
  | { status: 'selected'; answers: Array<{ questionId: string; prompt: string; source: 'option' | 'text'; text: string }> }
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
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Turn stopped.', 'AbortError'));
    return this.start(identity, toolCallId, candidate, signal, true).result;
  }

  start(identity: RuntimeEventIdentity, toolCallId: string, candidate: SolutionSelectionInput,
    signal?: AbortSignal, blocking = false): { request: RuntimeSolutionSelection; result: Promise<SolutionResult> } {
    const input = solutionSelectionInputSchema.parse(candidate);
    signal?.throwIfAborted();
    // One pending interaction per session; related questions belong in the same request.
    if (this.list(identity.sessionId).length) throw new Error('A solution selection is already pending in this session. Wait for that decision.');
    const request: RuntimeSolutionSelection = { ...input, selectionId: `solution_${randomUUID()}`,
      sessionId: identity.sessionId, turnId: identity.turnId, toolCallId, blocking, createdAt: new Date().toISOString() };
    const result = new Promise<SolutionResult>((resolve, reject) => {
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
    return { request, result };
  }

  answer(candidate: RuntimeSolutionAnswer): RuntimeSolutionAnswer {
    const answer = runtimeSolutionAnswerSchema.parse(candidate);
    const entry = this.#pending.get(answer.selectionId);
    if (!entry) throw Object.assign(new Error('Solution selection is not pending.'), { code: 'solution_not_pending' });
    if (entry.request.sessionId !== answer.sessionId || entry.request.turnId !== answer.turnId) {
      throw new Error('Solution selection belongs to a different session or Turn.');
    }
    const questions = solutionSelectionQuestions(entry.request);
    let result: SolutionResult;
    if (answer.kind === 'cancel') {
      result = { status: 'cancelled', message: 'The user dismissed this decision without selecting a solution. Do not infer approval, choose a default, or repeat the same request. Leave dependent work blocked and explain what remains unresolved; continue only independent work.' };
    } else if (answer.kind === 'answers') {
      if (!entry.request.questions || answer.answers.length !== questions.length
        || answer.answers.some(item => !questions.some(question => question.id === item.questionId))) {
        throw new Error('Answer every requested question exactly once.');
      }
      // Validate the entire batch before publishing any event or settling the wait.
      result = { status: 'selected', answers: questions.map(question => {
        const item = answer.answers.find(item => item.questionId === question.id)!;
        if (item.kind === 'option' && item.optionIndex >= question.options.length) throw new Error('The selected solution does not exist.');
        return { questionId: question.id, prompt: question.prompt, source: item.kind,
          text: item.kind === 'text' ? item.text : question.options[item.optionIndex]! };
      }) };
    } else {
      if (entry.request.questions) throw new Error('Submit all question answers together.');
      if (answer.kind === 'option' && answer.optionIndex >= questions[0]!.options.length) throw new Error('The selected solution does not exist.');
      result = { status: 'selected', source: answer.kind,
        text: answer.kind === 'text' ? answer.text : questions[0]!.options[answer.optionIndex]! };
    }
    this.eventLog.append(entry.identity, answer.kind === 'cancel'
      ? { kind: 'solution_selection_cancelled', payload: { selectionId: answer.selectionId, reason: 'user_cancelled' } }
      : { kind: 'solution_selection_answered', payload: answer });
    this.#pending.delete(answer.selectionId);
    entry.detach();
    entry.resolve(result);
    return answer;
  }
}
