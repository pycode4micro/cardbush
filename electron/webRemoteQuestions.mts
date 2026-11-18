import { runtimeSolutionSelectionSchema, type RuntimeSolutionAnswer, type RuntimeSolutionSelection } from '@cardbush/bush-protocol';
import type { AgentJob } from './agentTypes.js';
import { remoteIdentity, type RemoteClient, type WebRemoteAgents } from './webRemoteAgents.mjs';
import { WebError } from './webCommon.mjs';
import { WebReadCache } from './webSessionReads.mjs';
import { uiText } from '@cardbush/platform/i18n';

type Pending = { question: RuntimeSolutionSelection; connectionId: string; job: AgentJob; remote: RuntimeSolutionSelection };
const prefix = 'remote_solution_';

/** Project only pending questions from owned remote jobs. The worker remains the
 * authority: no duplicated wait, model request, task submission or stored answer. */
export class WebRemoteQuestions {
  readonly #reads = new WebReadCache();
  readonly #availableReads = new WebReadCache();
  readonly #answers = new Map<string, { value: string; result: Promise<RuntimeSolutionAnswer> }>();
  constructor(readonly registry: WebRemoteAgents, readonly timeoutMs = 4_000) {}
  owns(selectionId: string) { return selectionId.startsWith(prefix); }
  #key(user: string, session: string) { return JSON.stringify([user, session]); }
  #owner(user: string, session: string) { return 'webparent_' + remoteIdentity(this.registry.secret, user, session); }

  async #source(user: string, session: string, connectionId: string, signal: AbortSignal): Promise<Pending[]> {
    const owner = this.#owner(user, session), pending: Pending[] = [];
    let client: RemoteClient | undefined;
    const load = async () => {
      signal.throwIfAborted();
      const connection = await this.registry.authorized(user, connectionId);
      signal.throwIfAborted();
      client = await this.registry.clientFactory(connection);
      try {
        // A factory may finish after the deadline; never leak its SSH client.
        signal.throwIfAborted();
        const info = await client.info(signal);
        if (info.id !== connection.agentId || !info.capabilities.delegation) throw new WebError(409, uiText()('web.remoteQuestionIdentityChanged'));
        const jobs = await client.call('chat.jobs', {}, signal) as AgentJob[];
        const owned = jobs.filter(job => ['running', 'queued'].includes(job.status) && job.delegation?.parentSessionId === owner);
        for (const job of owned) {
          // Job ownership is assigned by delegation.submit, never by the browser.
          // Avoid downloading a potentially large private transcript just to poll.
          const questions = await client.call('runtime.command', { kind: 'runtime.list_solution_selections', payload: { sessionId: job.sessionId } }, signal) as unknown[];
          for (const raw of questions) {
            const remote = runtimeSolutionSelectionSchema.parse(raw);
            if (remote.sessionId !== job.sessionId || remote.turnId !== job.turnId) continue;
            const identity = remoteIdentity(this.registry.secret, user, session, connectionId, job.id, remote.selectionId);
            pending.push({ connectionId, job, remote, question: { ...remote,
              selectionId: prefix + identity, sessionId: session, turnId: 'remote_turn_' + identity, toolCallId: 'remote_question_' + identity } });
          }
        }
        await this.registry.authorized(user, connectionId);
        signal.throwIfAborted();
        return pending;
      } finally { client.close(); }
    };
    let abort = () => {};
    const deadline = new Promise<never>((_, reject) => {
      abort = () => { client?.close(); reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([load(), deadline]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async #pending(user: string, session: string, selectionId?: string): Promise<Pending[]> {
    const pending: Pending[] = [];
    let unavailable = false;
    for (const entry of await this.registry.list(user)) {
      try { pending.push(...await this.#source(user, session, entry.id, AbortSignal.timeout(this.timeoutMs))); }
      catch (error) { if (!selectionId) throw error; unavailable = true; }
      if (selectionId && pending.some(item => item.question.selectionId === selectionId)) return pending;
    }
    if (selectionId && unavailable) throw new WebError(503, uiText()('web.remoteQuestionsOffline'));
    return pending;
  }

  /** Remote reads have their own bounded queue/deadline. A failing source cannot
   * fail local questions or other sources, and failed polls are briefly cached. */
  async read(user: string, session: string) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const connections = await this.registry.list(user);
    const sources = await Promise.all(connections.map(entry => this.#availableReads.get(
      this.#key(user, session) + ':' + entry.id, 5_000, async () => {
        try { return { items: (await this.#source(user, session, entry.id, signal)).map(item => item.question), unavailable: false }; }
        catch { return { items: [], unavailable: true }; }
      }).catch(() => ({ items: [], unavailable: true }))));
    // Revocation also wins over cached results and failures.
    const allowed = new Set((await this.registry.list(user)).map(entry => entry.id));
    const current = sources.filter((_, index) => allowed.has(connections[index].id));
    return { items: current.flatMap(source => source.items), unavailable: current.some(source => source.unavailable) };
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
      const entry = (await this.#pending(user, answer.sessionId, answer.selectionId)).find(item => item.question.selectionId === answer.selectionId);
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
    finally { this.#answers.delete(identity); this.#reads.invalidate(key); this.#availableReads.invalidate(key); }
  }
}
