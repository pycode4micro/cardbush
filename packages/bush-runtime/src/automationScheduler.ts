import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { blobCacheEntries } from './cacheMaintenance.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { automationCommandSchema, automationDefinitionSchema, runtimeSessionTurnRequestSchema, modelGenerationParametersSchema, isAutomationResult, type AutomationJob, type AutomationRun, type AutomationOverview, type AutomationReminder, type AutomationConversation, type RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';

type Context = z.infer<typeof contextSchema>;
type State = { version: 1; jobs: AutomationJob[]; contexts: Record<string, Context>; jobContexts: Record<string, Context> };
const contextSchema = runtimeSessionTurnRequestSchema.pick({ model: true, providerBinding: true, prefixMessages: true, tools: true, permissionMode: true, requestCapabilities: true, metadata: true })
  .extend({ ...modelGenerationParametersSchema.shape, title: z.string() });
const runSchema = z.object({ id: z.string(), turnId: z.string(), queuedAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'awaiting_user_action']), reason: z.string(), error: z.string().optional(),
  sessionId: z.string().optional(), readAt: z.string().optional(), summary: z.string().optional(), result: z.string().optional() });
const jobSchema = automationDefinitionSchema.extend({ id: z.string(), revision: z.number().int().positive(), state: z.enum(['active', 'paused', 'completed']), createdAt: z.string(),
  nextRunAt: z.string().optional(), lastEventAt: z.string().optional(), lastEventIds: z.array(z.string()), runs: z.array(runSchema),
  plugin: z.object({ id: z.string(), hookId: z.string(), definitionHash: z.string() }).optional() });
const activeRun = (job: AutomationJob) => job.runs.find(run => run.status === 'queued' || run.status === 'running');
const executionMode = (definition: { trigger: AutomationJob['trigger']; executionMode?: AutomationJob['executionMode'] }) =>
  definition.trigger.kind === 'event' ? (definition.executionMode ?? 'conversation') : 'isolated';
const nextInterval = (job: AutomationJob, now: number) => {
  if (job.trigger.kind !== 'interval') return undefined;
  const anchor = Date.parse(job.trigger.at), step = job.trigger.seconds * 1000;
  return new Date(anchor + Math.max(0, Math.floor((now - anchor) / step) + 1) * step).toISOString();
};

/** Single runtime owner for UI, agent tools and trusted hook wakeups. */
export class AutomationScheduler {
  private state: State = { version: 1, jobs: [], contexts: {}, jobContexts: {} };
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private started = false;
  private ticking = false;
  private readonly running = new Map<string, AbortController>();
  private readonly executions = new Set<Promise<void>>();
  constructor(private readonly options: {
    path: string; now?: () => number; canRun: (sessionId: string) => boolean; sessionExists?: (sessionId: string) => boolean;
    run: (job: AutomationJob, run: AutomationRun, context: Context, signal: AbortSignal) => Promise<{ status: 'completed' | 'failed' | 'stopped' | 'awaiting_user_action'; reason: string; result?: string }>;
    changed?: () => void; onError?: (error: unknown) => void;
  }) { this.ready = this.load(); void this.ready.catch(error => this.options.onError?.(error)); }
  private now() { return this.options.now?.() ?? Date.now(); }
  notify() { try { this.options.changed?.(); } catch (error) { this.options.onError?.(error); } }
  private async load() {
    let raw;
    try { raw = JSON.parse(await readFile(this.options.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (raw.version !== 1 || !raw.contexts || typeof raw.contexts !== 'object' || Array.isArray(raw.contexts)) throw new Error('Invalid automation store.');
    this.state = { version: 1, jobs: z.array(jobSchema).parse(raw.jobs), contexts: z.record(z.string(), contextSchema).parse(raw.contexts),
      jobContexts: z.record(z.string(), contextSchema).parse(raw.jobContexts ?? {}) };
    let changed = false;
    // Only unstarted clock runs can move to a temporary conversation. Recorded
    // sessions stay intact, and plugin wakeups remain bound to their source.
    for (const job of this.state.jobs) {
      const mode = job.plugin ? 'conversation' : executionMode(job);
      if (job.executionMode !== mode) { job.executionMode = mode; changed = true; }
      for (const run of job.runs) run.sessionId ??= job.sessionId;
      if (mode === 'isolated') {
        if (!this.state.jobContexts[job.id] && this.state.contexts[job.sessionId]) {
          this.state.jobContexts[job.id] = structuredClone(this.state.contexts[job.sessionId]); changed = true;
        }
        for (const run of job.runs) if (run.status === 'queued' && !run.startedAt && run.sessionId === job.sessionId) {
          run.sessionId = `automation_session_${randomUUID()}`; changed = true;
        }
      }
    }
    let interrupted = false;
    for (const job of this.state.jobs) for (const run of job.runs) if (run.status === 'running') {
      run.status = 'interrupted'; run.finishedAt = new Date(this.now()).toISOString();
      run.error = 'Runtime stopped before completion was recorded. Check the conversation before running again.';
      job.state = 'paused'; job.revision++; interrupted = true;
    }
    if (interrupted || changed) await this.persist();
  }
  private async persist() {
    await mkdir(dirname(this.options.path), { recursive: true });
    const temp = `${this.options.path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 }); await rename(temp, this.options.path); }
    finally { await rm(temp, { force: true }); }
  }
  private async mutate<T>(change: () => T): Promise<T> {
    await this.ready;
    const result = this.queue.then(async () => {
      const before = structuredClone(this.state);
      try { const value = change(); await this.persist(); this.notify(); return structuredClone(value); }
      catch (error) { this.state = before; throw error; }
    });
    this.queue = result.catch(() => undefined); return result;
  }
  async remember(request: RuntimeSessionTurnRequest) {
    if (request.metadata.automationRunId || request.metadata.agentRole === 'child') return;
    await this.mutate(() => {
      const previous = this.state.contexts[request.sessionId];
      this.state.contexts[request.sessionId] = structuredClone(contextSchema.parse({ ...request,
        title: String(request.sessionMetadata?.title || previous?.title || request.sessionId),
        metadata: { ...request.metadata, ...(previous?.metadata.automationRunId ? {
          automationRunId: previous.metadata.automationRunId, automationId: previous.metadata.automationId,
        } : {}) },
      }));
    });
  }
  private sourceExists(sessionId: string) {
    return this.options.sessionExists?.(sessionId) ?? Object.hasOwn(this.state.contexts, sessionId);
  }
  private launchContext(job: AutomationJob) {
    return job.executionMode === 'isolated' ? this.state.jobContexts[job.id] : this.state.contexts[job.sessionId];
  }
  async list(sessionId?: string): Promise<AutomationOverview> {
    await this.ready; await this.queue;
    return structuredClone({ jobs: this.state.jobs.filter(job => !sessionId || job.sessionId === sessionId).map(job => ({ ...job, runs: job.runs.map(({ result: _result, ...run }) => run) })),
      sessions: Object.entries(this.state.contexts).filter(([id, context]) => (!sessionId || id === sessionId) &&
        (!context.metadata.automationRunId || this.state.jobs.some(job => job.sessionId === id)) && this.sourceExists(id))
        .map(([id, context]) => ({ id, title: context.title, model: context.model })), available: !this.closed });
  }
  get busy() { return this.ticking || this.executions.size > 0; }
  async cacheEntries() {
    await this.ready; await this.queue;
    return blobCacheEntries(dirname(this.options.path), 'automation_temporary', name => /^automations\.json\.[a-f0-9-]{36}\.tmp$/.test(name), 24 * 60 * 60_000);
  }

  async sessionDeleted(sessionId: string) {
    await this.ready; await this.queue;
    if (!this.state.contexts[sessionId] && !this.state.jobs.some(job => job.sessionId === sessionId && job.state === 'active')) return;
    await this.mutate(() => {
      delete this.state.contexts[sessionId];
      for (const job of this.state.jobs) if (job.sessionId === sessionId && (job.executionMode !== 'isolated' || job.trigger.kind === 'event')) {
        if (job.state === 'active') { job.state = 'paused'; job.revision++; delete job.nextRunAt; }
        const run = activeRun(job);
        if (run?.status === 'queued') { run.status = 'stopped'; run.finishedAt = new Date(this.now()).toISOString(); }
      }
    });
  }

  /** Jobs and unread results are durable; only unused launch contexts are disposable. */
  async collectContexts(sessions: Set<string>) {
    await this.ready; await this.queue;
    const keep = new Set([...sessions, ...this.state.jobs.flatMap(job => job.runs.map(run => run.sessionId ?? job.sessionId))]);
    const removed = Object.keys(this.state.contexts).filter(id => !keep.has(id));
    const unusedJobs = Object.keys(this.state.jobContexts).filter(id => !this.state.jobs.some(job => job.id === id));
    if (removed.length || unusedJobs.length) await this.mutate(() => {
      for (const id of removed) delete this.state.contexts[id];
      for (const id of unusedJobs) delete this.state.jobContexts[id];
    });
    return { removed: removed.length + unusedJobs.length, roots: structuredClone(this.state) };
  }
  async reminder(): Promise<AutomationReminder> {
    await this.ready; await this.queue;
    const unread = this.state.jobs.flatMap(job => job.runs.filter(run => isAutomationResult(run) && !run.readAt).map(run => ({
      jobId: job.id, runId: run.id, sessionId: run.sessionId ?? job.sessionId, title: job.name, status: run.status, finishedAt: run.finishedAt,
    }))).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return { asOf: new Date(this.now()).toISOString(), total: unread.length, items: unread.slice(0, 8) };
  }
  async manage(input: unknown, ownerSessionId?: string) {
    const command = automationCommandSchema.parse(input);
    if (command.action === 'list') return this.list(ownerSessionId);
    if (command.action === 'reminder') return this.reminder();
    if (command.action === 'results' || command.action === 'conversation') {
      await this.ready; await this.queue;
      const entries = this.state.jobs.filter(job => !ownerSessionId || job.sessionId === ownerSessionId).flatMap(job => job.runs.map(run => ({ job, run })))
        .filter(({ job, run }) => (!command.id || job.id === command.id) && (!command.runIds || command.runIds.includes(run.id)))
        .sort((a, b) => b.run.queuedAt.localeCompare(a.run.queuedAt));
      if (command.action === 'results') return structuredClone({ total: entries.length, results: entries.slice(command.offset ?? 0, (command.offset ?? 0) + 20).map(({ job, run }) => ({ jobId: job.id, title: job.name, ...run })) });
      const entry = entries[0];
      if (!entry || command.runIds?.length !== 1) throw new Error('Automation result not found.');
      const { job, run } = entry, sessionId = run.sessionId ?? job.sessionId;
      const context = this.state.contexts[sessionId] ?? this.launchContext(job);
      if (!context) throw new Error('No conversation execution context is available.');
      return structuredClone({ job: { ...job, runs: [run] }, run, sessionId,
        sourceSession: this.sourceExists(job.sessionId) ? { id: job.sessionId, title: this.state.contexts[job.sessionId]?.title ?? job.sessionId } : undefined,
        executionSessionAvailable: this.options.sessionExists?.(sessionId),
        model: context.providerBinding?.bindingId ?? context.model, modelName: context.model,
        projectDir: typeof context.metadata.projectDir === 'string' ? context.metadata.projectDir : undefined,
        workspaceDir: typeof context.metadata.workspaceDir === 'string' ? context.metadata.workspaceDir : undefined,
        permissionMode: context.permissionMode, reasoningEffort: context.reasoningEffort,
        allowedTools: context.tools.map(tool => tool.name),
        allowedSkills: Array.isArray(context.metadata.allowedSkills) ? context.metadata.allowedSkills.filter((item): item is string => typeof item === 'string') : undefined,
        disabledSkills: Array.isArray(context.metadata.disabledSkills) ? context.metadata.disabledSkills.filter((item): item is string => typeof item === 'string') : undefined,
        interactiveRequests: context.requestCapabilities.interactiveRequests, vision: context.requestCapabilities.vision } satisfies AutomationConversation);
    }
    if (this.closed) throw new Error('Automation scheduler is stopped.');
    let stopRunId: string | undefined;
    const result = await this.mutate(() => {
      if (command.action === 'mark_read' || command.action === 'mark_unread') {
        if (!command.runIds?.length) throw new Error('Select execution results to update.');
        const runs = this.state.jobs.filter(job => (!ownerSessionId || job.sessionId === ownerSessionId) && (!command.id || job.id === command.id))
          .flatMap(job => job.runs).filter(run => command.runIds!.includes(run.id));
        if (new Set(runs.map(run => run.id)).size !== new Set(command.runIds).size) throw new Error('Automation result not found.');
        if (runs.some(run => !isAutomationResult(run))) throw new Error('Wait for execution to finish before marking it read.');
        for (const run of runs) {
          if (command.action === 'mark_read') run.readAt ??= new Date(this.now()).toISOString();
          else delete run.readAt;
        }
        return { updated: runs.length };
      }
      const definition = command.definition;
      if (definition && ownerSessionId && definition.sessionId !== ownerSessionId) throw new Error('This tool can only manage automations in its own conversation.');
      if (command.action === 'create') {
        if (!definition) throw new Error('An automation definition is required.');
        if (!this.state.contexts[definition.sessionId] || !this.sourceExists(definition.sessionId)) throw new Error('Send a message in the target conversation before scheduling it.');
        if (this.state.jobs.length >= 500) throw new Error('Remove an automation before creating more (limit: 500).');
        const job: AutomationJob = { ...definition, executionMode: executionMode(definition), id: `automation_${randomUUID()}`, revision: 1, state: 'active', createdAt: new Date(this.now()).toISOString(),
          ...(definition.trigger.kind !== 'event' ? { nextRunAt: definition.trigger.at } : {}), lastEventIds: [], runs: [] };
        if (job.executionMode === 'isolated') this.state.jobContexts[job.id] = structuredClone(this.state.contexts[job.sessionId]);
        this.state.jobs.push(job); return job;
      }
      const job = this.state.jobs.find(job => job.id === command.id && (!ownerSessionId || job.sessionId === ownerSessionId));
      if (!job) throw new Error('Automation not found.');
      if (command.expectedRevision !== undefined && job.revision !== command.expectedRevision) throw new Error('Automation changed. Refresh before saving.');
      const active = activeRun(job);
      if (command.action === 'delete') {
        if (active?.status === 'running') throw new Error('Stop the running automation before deleting it.');
        this.state.jobs = this.state.jobs.filter(item => item.id !== job.id); delete this.state.jobContexts[job.id]; return { deleted: true, id: job.id };
      }
      if (command.action === 'update') {
        if (!definition) throw new Error('An automation definition is required.');
        if (active) throw new Error('Stop the queued or running automation before editing it.');
        const mode = executionMode(definition), sameSource = definition.sessionId === job.sessionId;
        const saved = sameSource ? this.state.jobContexts[job.id] : undefined;
        const source = this.sourceExists(definition.sessionId) ? this.state.contexts[definition.sessionId] : undefined;
        if ((!source && !saved) || ((mode === 'conversation' || definition.trigger.kind === 'event') && !source)) throw new Error('Send a message in the target conversation before scheduling it.');
        // Saving explicitly refreshes configuration; ordinary source turns never
        // silently change a timer's settings. A deleted source is optional.
        if (mode === 'isolated') this.state.jobContexts[job.id] = structuredClone(source ?? saved!);
        else delete this.state.jobContexts[job.id];
        Object.assign(job, definition, { executionMode: mode }); delete job.plugin;
        job.nextRunAt = definition.trigger.kind === 'event' ? undefined : definition.trigger.at;
        if (job.state === 'completed') job.state = 'active';
      } else if (command.action === 'pause') {
        job.state = 'paused';
        if (active?.status === 'queued') { active.status = 'stopped'; active.finishedAt = new Date(this.now()).toISOString(); }
      } else if (command.action === 'resume') {
        if (!this.launchContext(job) || (job.trigger.kind === 'event' && !this.sourceExists(job.sessionId))) throw new Error('No conversation execution context is available.');
        job.state = 'active';
        if (job.trigger.kind !== 'event') job.nextRunAt = job.trigger.kind === 'interval' ? nextInterval(job, this.now()) : job.trigger.at;
      } else if (command.action === 'run') {
        if (active) throw new Error('This automation is already queued or running.');
        if (!this.launchContext(job)) throw new Error('No conversation execution context is available.');
        this.enqueue(job, 'manual');
      } else if (command.action === 'stop') {
        if (active?.status === 'running') stopRunId = active.id;
        else if (active) { active.status = 'stopped'; active.finishedAt = new Date(this.now()).toISOString(); }
        job.state = 'paused';
      }
      job.revision++; return job;
    });
    if (stopRunId) this.running.get(stopRunId)?.abort();
    void this.tick().catch(error => this.options.onError?.(error));
    return result;
  }
  private enqueue(job: AutomationJob, reason: string) {
    const id = `run_${randomUUID()}`;
    job.runs.push({ id, sessionId: job.executionMode === 'isolated' ? `automation_session_${randomUUID()}` : job.sessionId,
      turnId: `automation_turn_${randomUUID()}`, queuedAt: new Date(this.now()).toISOString(), status: 'queued', reason });
    // Only acknowledged history can expire. Never lose unacknowledged results.
    const retained = new Set(job.runs.filter(run => run.readAt).slice(-50).map(run => run.id));
    job.runs = job.runs.filter(run => !run.readAt || retained.has(run.id));
  }
  async emit(event: { id: string; sessionId: string; event: string; tool?: string }) {
    if (this.closed) return;
    await this.ready; await this.queue;
    if (!this.state.jobs.some(job => job.state === 'active' && job.sessionId === event.sessionId && job.trigger.kind === 'event' && job.trigger.event === event.event)) return;
    await this.mutate(() => {
      for (const job of this.state.jobs) {
        const trigger = job.trigger;
        if (job.state !== 'active' || job.sessionId !== event.sessionId || trigger.kind !== 'event' || trigger.event !== event.event ||
            (trigger.tool && trigger.tool !== '*' && trigger.tool !== event.tool) || job.lastEventIds.includes(event.id)) continue;
        job.lastEventIds = [...job.lastEventIds, event.id].slice(-128);
        if (activeRun(job) || (job.lastEventAt && this.now() - Date.parse(job.lastEventAt) < trigger.cooldownSeconds * 1000)) continue;
        job.lastEventAt = new Date(this.now()).toISOString(); this.enqueue(job, `${event.event}${event.tool ? `: ${event.tool}` : ''}`); job.revision++;
      }
    });
  }
  async wakePlugin(input: { sessionId: string; prompt: string; plugin: NonNullable<AutomationJob['plugin']>; eventId: string }) {
    if (this.closed) return;
    await this.mutate(() => {
      if (!Object.hasOwn(this.state.contexts, input.sessionId)) throw new Error('No conversation execution context is available.');
      const previous = this.state.jobs.find(job => job.plugin?.hookId === input.plugin.hookId && job.sessionId === input.sessionId);
      if (previous && (previous.state === 'paused' || activeRun(previous) || previous.lastEventIds.includes(input.eventId))) return;
      const definition = automationDefinitionSchema.parse({ name: `${input.plugin.id}: ${input.prompt.slice(0, 70)}`.slice(0, 120), sessionId: input.sessionId, prompt: input.prompt, trigger: { kind: 'once', at: new Date(this.now()).toISOString() } });
      if (previous) {
        Object.assign(previous, definition, { plugin: input.plugin, state: 'active', revision: previous.revision + 1 });
        previous.lastEventIds = [...previous.lastEventIds, input.eventId].slice(-128);
        this.enqueue(previous, `hook: ${input.plugin.hookId}`); return;
      }
      if (this.state.jobs.length >= 500) throw new Error('Automation limit reached.');
      const job: AutomationJob = { ...definition, id: `automation_${randomUUID()}`, revision: 1, state: 'active', createdAt: new Date(this.now()).toISOString(), plugin: input.plugin, runs: [], lastEventIds: [input.eventId] };
      this.enqueue(job, `hook: ${input.plugin.hookId}`); this.state.jobs.push(job);
    });
  }
  start() { if (this.started || this.closed) return; this.started = true; this.schedule(); }
  private schedule() {
    this.timer = setTimeout(() => { void this.tick().catch(error => this.options.onError?.(error)).finally(() => { if (!this.closed) this.schedule(); }); }, 1000);
    this.timer.unref?.();
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      await this.ready; await this.queue;
      const now = this.now();
      if (this.state.jobs.some(job => job.state === 'active' && job.nextRunAt && Date.parse(job.nextRunAt) <= now && !activeRun(job))) await this.mutate(() => {
        for (const job of this.state.jobs) if (job.state === 'active' && job.nextRunAt && Date.parse(job.nextRunAt) <= now && !activeRun(job)) {
          this.enqueue(job, 'schedule'); job.nextRunAt = nextInterval(job, now); job.revision++;
        }
      });
      for (const job of this.state.jobs) {
        const run = activeRun(job);
        if (this.closed || this.running.size >= 3) break;
        if (!run || run.status !== 'queued' || !this.options.canRun(run.sessionId ?? job.sessionId) ||
            this.state.jobs.some(other => other.runs.some(item => (item.sessionId ?? other.sessionId) === (run.sessionId ?? job.sessionId) && this.running.has(item.id)))) continue;
        const controller = new AbortController(); this.running.set(run.id, controller);
        let claimed;
        try { claimed = await this.mutate(() => {
          const current = this.state.jobs.find(item => item.id === job.id), pending = current?.runs.find(item => item.id === run.id);
          if (!current || pending?.status !== 'queued') return;
          pending.status = 'running'; pending.startedAt = new Date(this.now()).toISOString(); current.revision++;
          const source = this.launchContext(current);
          if (pending.sessionId && pending.sessionId !== current.sessionId) {
            if (source) this.state.contexts[pending.sessionId] ??= { ...structuredClone(source), title: current.name,
              metadata: { ...source.metadata, automationRunId: pending.id, automationId: current.id } };
          }
          return { job: current, run: pending, context: source };
        }); } catch (error) { this.running.delete(run.id); throw error; }
        if (!claimed) { this.running.delete(run.id); continue; }
        const execution = this.execute(claimed, controller).finally(() => { this.running.delete(run.id); this.executions.delete(execution); });
        this.executions.add(execution);
      }
    } finally { this.ticking = false; }
  }
  private async execute(input: { job: AutomationJob; run: AutomationRun; context?: Context }, controller: AbortController) {
    let status: AutomationRun['status'] = 'failed', error: string | undefined, resultText: string | undefined;
    try {
      if (!input.context) throw new Error('No conversation execution context is available.');
      const result = await this.options.run(input.job, input.run, input.context, controller.signal); status = result.status; resultText = result.result?.slice(0, 12000); if (status === 'failed') error = result.reason;
    }
    catch (caught) {
      // Admission lost a race to a foreground turn; no model or tools ran.
      status = controller.signal.aborted ? 'stopped' : (caught as { code?: string })?.code === 'runtime_session_busy' ? 'queued' : 'failed';
      if (status === 'failed') error = caught instanceof Error ? caught.message : String(caught);
    }
    try { await this.mutate(() => {
      const job = this.state.jobs.find(item => item.id === input.job.id), run = job?.runs.find(item => item.id === input.run.id);
      if (!job || !run) return;
      if (status === 'queued') {
        run.status = 'queued'; delete run.startedAt; job.revision++; return;
      }
      Object.assign(run, { status, error: error?.slice(0, 2400), result: resultText, summary: (resultText || error || '').replace(/\s+/g, ' ').slice(0, 240), finishedAt: new Date(this.now()).toISOString() }); job.revision++;
      if (status === 'failed' || status === 'awaiting_user_action' || status === 'stopped') job.state = 'paused';
      else if (job.trigger.kind === 'once' && job.state === 'active') { job.state = 'completed'; delete job.nextRunAt; }
      if (job.trigger.kind === 'interval' && job.nextRunAt && Date.parse(job.nextRunAt) <= this.now()) job.nextRunAt = nextInterval(job, this.now());
    }); } catch (caught) { this.options.onError?.(caught); }
  }
  async close() { this.closed = true; clearTimeout(this.timer); for (const controller of this.running.values()) controller.abort(); await Promise.allSettled([...this.executions]); await this.queue; }
}
