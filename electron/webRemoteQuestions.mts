import { runtimeSolutionSelectionSchema, type RuntimeSolutionAnswer, type RuntimeSolutionSelection } from '@cardbush/bush-protocol';
import type { AgentJob } from './agentTypes.js';
import { remoteIdentity, type WebRemoteAgents } from './webRemoteAgents.mjs';
import { WebError } from './webCommon.mjs';
import { WebReadCache } from './webSessionReads.mjs';
import { uiText } from '@cardbush/platform/i18n';

type Pending = { question: RuntimeSolutionSelection; connectionId: string; job: AgentJob; remote: RuntimeSolutionSelection };
const prefix = 'remote_solution_';

/** Project only pending questions from owned remote jobs. The worker remains the
 * authority: no duplicated wait, model request, task submission or stored answer. */
export class WebRemoteQuestions {
  readonly #reads = new WebReadCache();
  readonly #answers = new Map<string, { value: string; result: Promise<RuntimeSolutionAnswer> }>();
  constructor(readonly registry: WebRemoteAgents) {}
  owns(selectionId: string) { return selectionId.startsWith(prefix); }
  #key(user: string, session: string) { return JSON.stringify([user, session]); }
  #owner(user: string, session: string) { return 'webparent_' + remoteIdentity(this.registry.secret, user, session); }

  async #pending(user: string, session: string): Promise<Pending[]> {
    const owner = this.#owner(user, session), pending: Pending[] = [];
    // Bound SSH fan-out and never query connections the account cannot use.
    for (const entry of await this.registry.list(user)) {
      const connection = await this.registry.authorized(user, entry.id);
      const client = await this.registry.clientFactory(connection);
      try {
        const info = await client.info();
        if (info.id !== connection.agentId || !info.capabilities.delegation) throw new WebError(409, uiText()('web.remoteQuestionIdentityChanged'));
        const jobs = await client.call('chat.jobs', {}) as AgentJob[];
        const owned = jobs.filter(job => ['running', 'queued'].includes(job.status) && job.delegation?.parentSessionId === owner);
        for (const job of owned) {
          // Job ownership is assigned by delegation.submit, never by the browser.
          // Avoid downloading a potentially large private transcript just to poll.
          const questions = await client.call('runtime.command', { kind: 'runtime.list_solution_selections', payload: { sessionId: job.sessionId } }) as unknown[];
          for (const raw of questions) {
            const remote = runtimeSolutionSelectionSchema.parse(raw);
            if (remote.sessionId !== job.sessionId || remote.turnId !== job.turnId) continue;
            const identity = remoteIdentity(this.registry.secret, user, session, entry.id, job.id, remote.selectionId);
            pending.push({ connectionId: entry.id, job, remote, question: { ...remote,
              selectionId: prefix + identity, sessionId: session, turnId: 'remote_turn_' + identity, toolCallId: 'remote_question_' + identity } });
          }
        }
        await this.registry.authorized(user, entry.id);
      } finally { client.close(); }
    }
    return pending;
  }

  async list(user: string, session: string) {
    const entries = await this.#reads.get(this.#key(user, session), 2_000, () => this.#pending(user, session));
    // Recheck revocation even when another tab warmed the cache.
    for (const id of new Set(entries.map(entry => entry.connectionId))) await this.registry.authorized(user, id);
    return entries.map(entry => entry.question);
  }

  async answer(user: string, answer: RuntimeSolutionAnswer): Promise<RuntimeSolutionAnswer> {
    const key = this.#key(user, answer.sessionId), identity = JSON.stringify([key, answer.selectionId]);
    const value = JSON.stringify(answer), existing = this.#answers.get(identity);
    if (existing) {
      if (existing.value !== value) throw new WebError(409, uiText()('web.remoteQuestionAnswerInProgress'));
      return existing.result;
    }
    const result = (async () => {
      // Never trust a client-supplied child ID or a cached ownership decision.
      const entry = (await this.#pending(user, answer.sessionId)).find(item => item.question.selectionId === answer.selectionId);
      if (!entry || entry.question.turnId !== answer.turnId) throw new WebError(409, uiText()('web.remoteQuestionNotPending'));
      const connection = await this.registry.authorized(user, entry.connectionId);
      const client = await this.registry.clientFactory(connection);
      try {
        if ((await client.info()).id !== connection.agentId) throw new WebError(409, uiText()('web.remoteQuestionIdentityChanged'));
        const mapped = { ...answer, selectionId: entry.remote.selectionId, sessionId: entry.remote.sessionId, turnId: entry.remote.turnId };
        await client.call('runtime.command', { kind: 'runtime.answer_solution_selection', payload: mapped });
        return answer;
      } finally { client.close(); }
    })();
    this.#answers.set(identity, { value, result });
    try { return await result; }
    finally { this.#answers.delete(identity); this.#reads.invalidate(key); }
  }
}
