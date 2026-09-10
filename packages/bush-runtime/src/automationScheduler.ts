import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { automationCommandSchema, automationDefinitionSchema, runtimeSessionTurnRequestSchema, type AutomationJob, type AutomationRun, type AutomationOverview, type RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';

type Context = Pick<RuntimeSessionTurnRequest, 'model' | 'providerBinding' | 'prefixMessages' | 'tools' | 'permissionMode' | 'requestCapabilities' | 'metadata' | 'maxOutputTokens' | 'reasoningEffort'> & { title: string };
type State = { version: 1; jobs: AutomationJob[]; contexts: Record<string, Context> };
const contextSchema = runtimeSessionTurnRequestSchema.pick({ model: true, providerBinding: true, prefixMessages: true, tools: true, permissionMode: true, requestCapabilities: true, metadata: true, maxOutputTokens: true, reasoningEffort: true }).extend({ title: z.string() });
const runSchema = z.object({ id: z.string(), turnId: z.string(), queuedAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'awaiting_user_action']), reason: z.string(), error: z.string().optional() });
const jobSchema = automationDefinitionSchema.extend({ id: z.string(), revision: z.number().int().positive(), state: z.enum(['active', 'paused', 'completed']), createdAt: z.string(),
  nextRunAt: z.string().optional(), lastEventAt: z.string().optional(), lastEventIds: z.array(z.string()), runs: z.array(runSchema),
  plugin: z.object({ id: z.string(), hookId: z.string(), definitionHash: z.string() }).optional() });
const activeRun = (job: AutomationJob) => job.runs.find(run => run.status === 'queued' || run.status === 'running');
const nextInterval = (job: AutomationJob, now: number) => {
  if (job.trigger.kind !== 'interval') return undefined;
  const anchor = Date.parse(job.trigger.at), step = job.trigger.seconds * 1000;
  return new Date(anchor + Math.max(0, Math.floor((now - anchor) / step) + 1) * step).toISOString();
};

/** Single runtime owner for UI, agent tools and trusted hook wakeups. */
export class AutomationScheduler {
  private state: State = { version: 1, jobs: [], contexts: {} };
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private started = false;
  private ticking = false;
  private readonly running = new Map<string, AbortController>();
  private readonly executions = new Set<Promise<void>>();
  constructor(private readonly options: {
    path: string; now?: () => number; canRun: (sessionId: string) => boolean;
    run: (job: AutomationJob, run: AutomationRun, context: Context, signal: AbortSignal) => Promise<{ status: 'completed' | 'failed' | 'stopped' | 'awaiting_user_action'; reason: string }>;
    changed?: () => void; onError?: (error: unknown) => void;
  }) { this.ready = this.load(); void this.ready.catch(error => this.options.onError?.(error)); }
  private now() { return this.options.now?.() ?? Date.now(); }
  notify() { try { this.options.changed?.(); } catch (error) { this.options.onError?.(error); } }
  private async load() {
    let raw;
    try { raw = JSON.parse(await readFile(this.options.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (raw.version !== 1 || !raw.contexts || typeof raw.contexts !== 'object' || Array.isArray(raw.contexts)) throw new Error('Invalid automation store.');
    this.state = { version: 1, jobs: z.array(jobSchema).parse(raw.jobs), contexts: z.record(z.string(), contextSchema).parse(raw.contexts) };
    let interrupted = false;
    for (const job of this.state.jobs) for (const run of job.runs) if (run.status === 'running') {
      run.status = 'interrupted'; run.finishedAt = new Date(this.now()).toISOString();
      run.error = 'Runtime stopped before completion was recorded. Check the conversation before running again.';
      job.state = 'paused'; job.revision++; interrupted = true;
    }
    if (interrupted) await this.persist();
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
    const { model, providerBinding, prefixMessages, tools, permissionMode, requestCapabilities, metadata, maxOutputTokens, reasoningEffort } = request;
    await this.mutate(() => { this.state.contexts = { ...this.state.contexts, [request.sessionId]: structuredClone({ model, providerBinding, prefixMessages, tools, permissionMode, requestCapabilities, metadata, maxOutputTokens, reasoningEffort,
      title: String(request.sessionMetadata?.title || this.state.contexts[request.sessionId]?.title || request.sessionId) }) }; });
  }
  async list(sessionId?: string): Promise<AutomationOverview> {
    await this.ready; await this.queue;
    return structuredClone({ jobs: this.state.jobs.filter(job => !sessionId || job.sessionId === sessionId),
      sessions: Object.entries(this.state.contexts).filter(([id]) => !sessionId || id === sessionId).map(([id, context]) => ({ id, title: context.title, model: context.model })), available: !this.closed });
  }
  async manage(input: unknown, ownerSessionId?: string) {
    const command = automationCommandSchema.parse(input);
    if (command.action === 'list') return this.list(ownerSessionId);
    if (this.closed) throw new Error('Automation scheduler is stopped.');
    let stopRunId: string | undefined;
    const result = await this.mutate(() => {
      const definition = command.definition;
      if (definition && ownerSessionId && definition.sessionId !== ownerSessionId) throw new Error('This tool can only manage automations in its own conversation.');
      if (definition && !Object.hasOwn(this.state.contexts, definition.sessionId)) throw new Error('Send a message in the target conversation before scheduling it.');
      if (command.action === 'create') {
        if (!definition) throw new Error('An automation definition is required.');
        if (this.state.jobs.length >= 500) throw new Error('Remove an automation before creating more (limit: 500).');
        const job: AutomationJob = { ...definition, id: `automation_${randomUUID()}`, revision: 1, state: 'active', createdAt: new Date(this.now()).toISOString(),
          ...(definition.trigger.kind !== 'event' ? { nextRunAt: definition.trigger.at } : {}), lastEventIds: [], runs: [] };
        this.state.jobs.push(job); return job;
      }
      const job = this.state.jobs.find(job => job.id === command.id && (!ownerSessionId || job.sessionId === ownerSessionId));
      if (!job) throw new Error('Automation not found.');
      if (command.expectedRevision !== undefined && job.revision !== command.expectedRevision) throw new Error('Automation changed. Refresh before saving.');
      const active = activeRun(job);
      if (command.action === 'delete') {
        if (active?.status === 'running') throw new Error('Stop the running automation before deleting it.');
        this.state.jobs = this.state.jobs.filter(item => item.id !== job.id); return { deleted: true, id: job.id };
      }
      if (command.action === 'update') {
        if (!definition) throw new Error('An automation definition is required.');
        if (active) throw new Error('Stop the queued or running automation before editing it.');
        Object.assign(job, definition); delete job.plugin;
        job.nextRunAt = definition.trigger.kind === 'event' ? undefined : definition.trigger.at;
        if (job.state === 'completed') job.state = 'active';
      } else if (command.action === 'pause') {
        job.state = 'paused';
        if (active?.status === 'queued') { active.status = 'stopped'; active.finishedAt = new Date(this.now()).toISOString(); }
      } else if (command.action === 'resume') {
        job.state = 'active';
        if (job.trigger.kind !== 'event') job.nextRunAt = job.trigger.kind === 'interval' ? nextInterval(job, this.now()) : job.trigger.at;
      } else if (command.action === 'run') {
        if (active) throw new Error('This automation is already queued or running.');
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
    job.runs.push({ id, turnId: `automation_turn_${randomUUID()}`, queuedAt: new Date(this.now()).toISOString(), status: 'queued', reason });
    job.runs = job.runs.slice(-50);
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
        if (!run || run.status !== 'queued' || !this.options.canRun(job.sessionId) ||
            this.state.jobs.some(other => other.sessionId === job.sessionId && other.runs.some(item => this.running.has(item.id)))) continue;
        const controller = new AbortController(); this.running.set(run.id, controller);
        let claimed;
        try { claimed = await this.mutate(() => {
          const current = this.state.jobs.find(item => item.id === job.id), pending = current?.runs.find(item => item.id === run.id);
          if (!current || pending?.status !== 'queued') return;
          pending.status = 'running'; pending.startedAt = new Date(this.now()).toISOString(); current.revision++;
          return { job: current, run: pending, context: this.state.contexts[current.sessionId] };
        }); } catch (error) { this.running.delete(run.id); throw error; }
        if (!claimed) { this.running.delete(run.id); continue; }
        const execution = this.execute(claimed, controller).finally(() => { this.running.delete(run.id); this.executions.delete(execution); });
        this.executions.add(execution);
      }
    } finally { this.ticking = false; }
  }
  private async execute(input: { job: AutomationJob; run: AutomationRun; context: Context }, controller: AbortController) {
    let status: AutomationRun['status'] = 'failed', error: string | undefined;
    try { const result = await this.options.run(input.job, input.run, input.context, controller.signal); status = result.status; if (status === 'failed') error = result.reason; }
    catch (caught) {
      // Admission lost a race to a foreground turn; no model or tools ran.
      status = controller.signal.aborted ? 'stopped' : (caught as { code?: string })?.code === 'runtime_session_busy' ? 'queued' : 'failed';
      if (status !== 'queued') error = caught instanceof Error ? caught.message : String(caught);
    }
    try { await this.mutate(() => {
      const job = this.state.jobs.find(item => item.id === input.job.id), run = job?.runs.find(item => item.id === input.run.id);
      if (!job || !run) return;
      if (status === 'queued') {
        run.status = 'queued'; delete run.startedAt; job.revision++; return;
      }
      Object.assign(run, { status, error, finishedAt: new Date(this.now()).toISOString() }); job.revision++;
      if (status === 'failed' || status === 'awaiting_user_action' || status === 'stopped') job.state = 'paused';
      else if (job.trigger.kind === 'once' && job.state === 'active') { job.state = 'completed'; delete job.nextRunAt; }
      if (job.trigger.kind === 'interval' && job.nextRunAt && Date.parse(job.nextRunAt) <= this.now()) job.nextRunAt = nextInterval(job, this.now());
    }); } catch (caught) { this.options.onError?.(caught); }
  }
  async close() { this.closed = true; clearTimeout(this.timer); for (const controller of this.running.values()) controller.abort(); await Promise.allSettled([...this.executions]); await this.queue; }
}
