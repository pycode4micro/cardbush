import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { runtimeSessionReadRequestSchema } from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest, GOAL_CONTINUATION_PROMPT } from '@cardbush/bush-product-agent';
import { DEFAULT_CHILD_AGENT_DISABLED_TOOLS, sessionSupersessionSchema, reasoningEffortSchema, decodeSessionSnapshot, type SessionSnapshot, type RuntimeEvent, type RuntimeProviderBindingRef, type ConversationExtractSource, type ToolDefinition } from '@cardbush/bush-protocol';
import { AgentRuntimeHost } from './agentRuntimeHost.mjs';
import { AgentPluginMarketplaces } from './agentPluginMarketplaces.mjs';
import { SandboxSetup } from './sandboxSetup.mjs';
import { ElectronProductHostController } from './productHostController.mjs';
import { GlobalInstructionsStore, readAgentInstructionDocuments } from './globalInstructions.js';
import { installProductPlugin } from './productPlugins.js';
import { loadEnabledProductPluginExtensions } from './productPlugins.js';
import { listProductSkills, readProductSkill } from './productSkills.js';
import { agentFileRead, agentFileUpload } from './agentFiles.mjs';
import { readWorkspaceDirectory } from './workspaceFiles.js';
import type { AgentEventRequest, AgentInfo, AgentJob, AgentOperation, AgentProject } from './agentTypes.js';

const id = z.string().min(1).max(160);
const sendSchema = z.object({
  userMessageMetadata: z.record(z.string(), z.unknown()).optional(),
  visionEnabled: z.boolean().optional(),
  conversationStyle: z.object({ mode: z.enum(['natural', 'professional', 'concise', 'custom']), customTone: z.string().max(100_000) }).strict().optional(),
  turnId: id.optional(), supersession: sessionSupersessionSchema.extend({ expectedRevision: z.number().int().nonnegative() }).optional(), files: z.array(z.string()).optional(), images: z.array(z.string()).optional(), goalObjective: z.string().trim().min(1).optional(),
  requestId: id, sessionId: id, text: z.string().trim().min(1).max(1_000_000), modelId: id,
  permissionMode: z.enum(['task_free', 'user_free', 'all_free']).default('task_free'),
  language: z.enum(['zh', 'en']).default('zh'),
  reasoningEffort: reasoningEffortSchema.optional(), planEnabled: z.boolean().optional(), disabledSkills: z.array(z.string()).optional(), subagentPermissionRouting: z.enum(['user', 'parent']).optional(),
}).strict();
type SessionPresentation = { title?: string; pinned?: boolean; archived?: boolean; readAt?: string; forcedUnread?: boolean };
type AgentState = { version: 1; id: string; name: string; revision: number; projects: AgentProject[]; defaultProjectId: string | null; jobs: AgentJob[]; sessions?: Record<string, SessionPresentation> };

/** Owns all business state. Transport sessions and UI lifetimes never own a turn. */
export class AgentService {
  readonly root: string;
  readonly bundledRoot: string;
  readonly runtime: AgentRuntimeHost;
  readonly product: ElectronProductHostController;
  readonly instructions: GlobalInstructionsStore;
  readonly #marketplaces: AgentPluginMarketplaces;
  #state: AgentState;
  #writes: Promise<unknown> = Promise.resolve();
  #mutations: Promise<unknown> = Promise.resolve();
  #busy = new Map<string, AbortController>();
  #assigned = new Map<string, string>();
  #closing = false;
  #storageFailure?: string;
  #stateListeners = new Set<() => void>();
  #releaseLock: () => Promise<void>;

  private constructor(root: string, state: AgentState, release: () => Promise<void>, options: { env?: NodeJS.ProcessEnv; bundledRoot?: string }, sandbox: SandboxSetup) {
    this.root = root; this.#state = state; this.#releaseLock = release;
    const runtimeRoot = join(root, 'runtime-state');
    const bundled = options.bundledRoot ?? join(root, 'bundled');
    this.bundledRoot = bundled;
    this.instructions = new GlobalInstructionsStore(join(root, 'AGENTS.md'));
    const sourceEnv = { ...process.env, ...options.env };
    const env = { ...sourceEnv };
    // Never inherit the desktop's private endpoints, credentials or data directories.
    for (const key of Object.keys(env)) if (key.startsWith('CARDBUSH_')) delete env[key];
    // These are deployment policies, not desktop credentials or transport state.
    for (const key of ['CARDBUSH_EXECUTION_SANDBOX', 'CARDBUSH_SANDBOX_NETWORK', 'CARDBUSH_SANDBOX_READ_ROOTS', 'CARDBUSH_SANDBOX_WRITE_ROOTS', 'CARDBUSH_BWRAP_PATH']) {
      if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
    }
    Object.assign(env, options.env, {
      CARDBUSH_SERVICE_ID: state.id, CARDBUSH_RUNTIME_STATE_ROOT: runtimeRoot,
      CARDBUSH_SANDBOX_SETTINGS_PATH: join(root, 'config', 'sandbox.json'),
      CARDBUSH_SUBAGENT_CONFIG_PATH: join(root, 'config', 'subagents.json'),
      CARDBUSH_APPS_CONFIG_PATH: join(root, 'config', 'apps.json'),
      CARDBUSH_RUNTIME_SKILL_ROOTS: JSON.stringify([join(bundled, 'skills'), join(root, 'skills')]),
      CARDBUSH_RUNTIME_PLUGIN_ROOTS: JSON.stringify([{ path: join(bundled, 'plugins'), source: 'bundled' }, { path: join(root, 'plugins'), source: 'user' }]),
    });
    for (const key of ['CARDBUSH_APPS_MCP_ENTRY', 'CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY', 'CARDBUSH_CHROME_REMOTE_DEBUGGING_MCP_ENTRY', 'CARDBUSH_MCP_DESKTOP_BRIDGE', 'CARDBUSH_RESOURCE_COORDINATION']) delete env[key];
    this.runtime = new AgentRuntimeHost(env, async (operation, payload) => {
      const data = payload as Record<string, unknown>;
      if (operation === 'subagent.models') return this.product.subagentModels();
      if (operation === 'subagent.prepare-model') return this.product.resolveSubagentModel(String(data.modelId));
      if (operation === 'automation.prepare-model') return this.product.resolveAutomationModel(String(data.modelId));
      if (operation === 'automation.changed') return null;
      // No desktop fallback: unsupported integrations cannot act on the client machine.
      throw new Error(`This headless Agent does not provide ${operation}.`);
    });
    this.product = new ElectronProductHostController({
      sandbox,
      dataRoot: root, runtimeStateRoot: runtimeRoot, runtimeBridge: this.runtime,
      bundledSkillRoot: join(bundled, 'skills'), userSkillRoot: join(root, 'skills'),
      bundledPluginRoot: join(bundled, 'plugins'), userPluginRoot: join(root, 'plugins'),
      clearApplicationCaches: () => this.#marketplaces.collectCache(),
    });
    this.#marketplaces = new AgentPluginMarketplaces(root, bundled, (pluginId, replace) => this.product.replacePlugin(pluginId, replace), env);
  }

  static async open(options: { dataRoot: string; name?: string; env?: NodeJS.ProcessEnv; bundledRoot?: string }) {
    if (!isAbsolute(options.dataRoot)) throw new Error('Agent dataRoot must be absolute.');
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(options.dataRoot);
    // Refuse to adopt a desktop profile or another application's data silently.
    const file = join(root, 'agent.json');
    const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!existing && await stat(join(root, 'runtime-state')).then(() => true, () => false)) throw new Error('Use a separate data directory for this Agent; this directory already contains Runtime data.');
    const lockPath = join(root, 'agent.lock');
    const acquire = () => open(lockPath, 'wx', 0o600);
    let lock;
    try { lock = await acquire(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Agent lock is invalid; check the service before removing agent.lock.');
      try { process.kill(owner, 0); throw new Error('Another Agent already owns this data directory.'); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
      await rm(lockPath); lock = await acquire();
    }
    await lock.writeFile(String(process.pid));
    const release = async () => { await lock.close(); await rm(lockPath, { force: true }); };
    let service: AgentService | undefined;
    try {
      const state: AgentState = existing ? JSON.parse(existing) : { version: 1, id: `agent-${randomUUID()}`, name: options.name?.trim() || 'CardBush Agent', revision: 0, projects: [], defaultProjectId: null, jobs: [] };
      if (state.version !== 1 || !state.id || !Array.isArray(state.jobs) || !Array.isArray(state.projects)) throw new Error('Unsupported or corrupt Agent data.');
      const sandbox = new SandboxSetup({ path: join(root, 'config', 'sandbox.json'), env: options.env });
      await sandbox.get().catch(error => console.warn('[sandbox-check]', error));
      service = new AgentService(root, state, release, options, sandbox);
      await service.runtime.ready;
      await service.#write(next => {
        if (options.name?.trim()) next.name = options.name.trim();
        // A crash is not permission to repeat side effects. Queued work can resume;
        // interrupted turns remain inspectable through the Runtime recovery API.
        for (const job of next.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.error = 'Service restarted during this turn. Inspect history before retrying.'; }
      });
      await service.product.refreshMcp();
      await service.runtime.transport.sendCommand({ kind: 'runtime.automation_start', payload: {} });
      service.#pump();
      return service;
    } catch (error) { if (service) await service.runtime.close(); await release(); throw error; }
  }

  info(): AgentInfo { return { protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'], id: this.#state.id, name: this.#state.name, platform: process.platform,
    capabilities: { desktop: false, computerUse: false, browserUi: false, durableQueue: true, eventReplay: true, projects: true, models: true, plugins: true, delegation: true, conversationUi: true, conversationManagement: true, sharedConversation: true, sharedSettings: true, sandboxSettings: true, pluginMarketplace: true } }; }
  #present<T extends { sessionId: string; metadata?: Record<string, unknown>; turns?: Array<{ messages: Array<{ message: { role: string; content?: string; visibility?: string; name?: string } }> }> }>(session: T): T {
    const presentation = this.#state.sessions?.[session.sessionId];
    const saved = String(presentation?.title ?? session.metadata?.title ?? '').trim();
    const placeholder = !presentation?.title && (!saved || ['新对话', '新会话', 'New conversation', 'New chat', session.sessionId].includes(saved));
    const first = session.turns?.flatMap(turn => turn.messages).find(item => item.message.role === 'user' && item.message.visibility !== 'internal' && item.message.name !== 'subagent_result')?.message.content
      ?? this.#state.jobs.find(job => job.sessionId === session.sessionId)?.input.text;
    // Presentation is independent of the model journal and may change during a turn.
    const title = placeholder && first ? first.replace(/\s+/g, ' ').trim().slice(0, 48) : saved;
    return { ...session, metadata: { ...session.metadata, ...presentation, title } };
  }
  #write(change: (state: AgentState) => void): Promise<void> {
    const task = this.#writes.then(async () => {
      const next = structuredClone(this.#state); change(next); next.revision++;
      const temp = join(this.root, `agent.${randomUUID()}.tmp`);
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(temp, join(this.root, 'agent.json'));
        this.#state = next;
        for (const listener of this.#stateListeners) listener();
      } finally { await rm(temp, { force: true }); }
    });
    this.#writes = task.catch(() => undefined); return task;
  }
  async #product(command: Record<string, unknown>) {
    const result = await this.product.execute({ ...command, protocol: 'cardbush.product_host_ipc.v1' }) as { ok: boolean; value?: unknown; error?: { message: string } };
    if (!result.ok) throw new Error(result.error?.message || 'Product command failed.');
    if (command.kind === 'apps.update' || command.kind === 'mcp.update') await this.product.refreshMcp();
    return result.value;
  }
  #command(kind: string, payload: unknown = {}) { return this.runtime.transport.sendCommand({ kind, payload }); }
  #active(sessionId: string) { return this.#state.jobs.some(job => job.sessionId === sessionId && (job.status === 'queued' || job.status === 'running')); }
  #idle(sessionId?: string) { if (sessionId ? this.#active(sessionId) : this.#state.jobs.some(job => ['queued', 'running'].includes(job.status))) throw new Error('Wait for this Agent’s tasks to finish or stop them first.'); }

  call(operation: AgentOperation, input: unknown = {}, readSignal?: AbortSignal): Promise<unknown> {
    const serialized = ['files.upload', 'delegation.submit', 'chat.send', 'chat.queue', 'chat.stop', 'sessions.create', 'sessions.rename', 'sessions.update', 'sessions.fork', 'sessions.delete', 'sessions.bind', 'projects.save', 'projects.remove', 'projects.default'];
    const workspaceMutation = operation === 'runtime.command' && /(?:revert|restore|update)_workspace|delete_session|clear_sessions|switch_workspace/.test(String((input as { kind?: string })?.kind));
    if (!serialized.includes(operation) && !workspaceMutation) return this.#call(operation, input, readSignal);
    const result = this.#mutations.then(() => this.#call(operation, input));
    this.#mutations = result.catch(() => undefined); return result;
  }
  async #call(operation: AgentOperation, input: unknown, readSignal?: AbortSignal): Promise<unknown> {
    if (this.#closing) throw new Error('Agent is shutting down.');
    if (this.#storageFailure) throw new Error(this.#storageFailure);
    const data = z.record(z.string(), z.unknown()).parse(input);
    const sessionId = () => id.parse(data.sessionId);
    switch (operation) {
      case 'conversation.catalog': {
        const roots = [{ path: join(this.bundledRoot, 'plugins'), source: 'bundled' as const }, { path: join(this.root, 'plugins'), source: 'user' as const }];
        const extensions = await loadEnabledProductPluginExtensions(roots, join(this.root, 'config', 'apps.json'));
        if (data.action === 'read') {
          const name = z.string().trim().min(1).parse(data.name);
          const extension = extensions.skills.find(skill => skill.id === name);
          if (extension) return { name, description: extension.description, path: extension.path, packageDir: dirname(extension.path),
            content: await readFile(extension.path, 'utf8'), routingHidden: false, requires: [], conflictsWith: [], companionTools: [], blockedTools: [], requiredReads: [], conditionalReads: [], resourceQuickRefs: [] };
          return readProductSkill([{ path: join(this.bundledRoot, 'skills'), source: 'bundled' }, { path: join(this.root, 'skills'), source: 'user' }], name);
        }
        const skills = await listProductSkills([{ path: join(this.bundledRoot, 'skills'), source: 'bundled' }, { path: join(this.root, 'skills'), source: 'user' }]);
        return { skills: [...skills.map(skill => ({ ...skill, logoPath: '', logoDarkPath: '' })), ...extensions.skills.map(skill => ({ name: skill.id, path: skill.path, description: skill.description }))],
          pluginCommands: extensions.commands.filter(command => command.userInvocable).map(command => ({ id: command.id, pluginId: command.pluginId, name: command.name, path: command.path, description: command.description, argumentHint: command.argumentHint, kind: command.kind ?? 'command' })) };
      }
      case 'files.read': case 'files.upload': case 'files.list': {
        const snapshot = decodeSessionSnapshot(await this.#command('runtime.get_session', { sessionId: sessionId() }));
        const workspace = snapshot.metadata?.runtimeWorkspace as { workspaceDir?: string } | undefined;
        if (!workspace?.workspaceDir) throw new Error('Conversation workspace is unavailable.');
        if (operation === 'files.list') return readWorkspaceDirectory({ rootPath: workspace.workspaceDir, directoryPath: z.string().optional().parse(data.directoryPath), offset: z.number().int().nonnegative().optional().parse(data.offset) });
        return operation === 'files.read' ? agentFileRead(workspace.workspaceDir, data) : agentFileUpload(workspace.workspaceDir, data);
      }
      case 'info': return this.info();
      case 'plugins.marketplace': {
        const result = await this.#marketplaces.call(data);
        if (data.action === 'install') await this.product.refreshMcp();
        return result;
      }
      case 'projects.list': return { revision: this.#state.revision, projects: this.#state.projects, defaultProjectId: this.#state.defaultProjectId };
      case 'projects.save': {
        const path = z.string().min(1).parse(data.path);
        if (!isAbsolute(path)) throw new Error('Project path must be absolute on the Agent host.');
        const canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) throw new Error('Project path is not a directory.');
        const project = { id: data.id ? id.parse(data.id) : randomUUID(), name: z.string().trim().min(1).max(100).parse(data.name), path: canonical };
        await this.#write(state => {
          if (state.projects.some(item => item.id === project.id && item.path !== project.path)) throw new Error('Add a new project to use a different directory.');
          state.projects = [...state.projects.filter(item => item.id !== project.id), project];
          if (!state.defaultProjectId) state.defaultProjectId = project.id;
        });
        return project;
      }
      case 'projects.remove': {
        const projectId = id.parse(data.id);
        await this.#write(state => { state.projects = state.projects.filter(item => item.id !== projectId); if (state.defaultProjectId === projectId) state.defaultProjectId = null; });
        return { removed: true }; // Existing conversations retain their actual directory.
      }
      case 'projects.default': {
        const projectId = data.id === null ? null : id.parse(data.id);
        await this.#write(state => { if (projectId && !state.projects.some(item => item.id === projectId)) throw new Error('Unknown project.'); state.defaultProjectId = projectId; });
        return { defaultProjectId: projectId };
      }
      case 'sessions.list': return (await this.#command('runtime.list_sessions') as SessionSnapshot[]).map(session => this.#present(session));
      case 'sessions.get': { const snapshot = await this.#command('runtime.get_session', runtimeSessionReadRequestSchema.parse(data)); return snapshot ? this.#present(decodeSessionSnapshot(snapshot)) : null; }
      case 'sessions.create': {
        const key = data.sessionId ? sessionId() : `session-${randomUUID()}`;
        if (await this.#command('runtime.get_session', { sessionId: key })) throw new Error('This conversation ID already exists.');
        const projectId = data.projectId === undefined ? this.#state.defaultProjectId : data.projectId;
        const project = this.#state.projects.find(item => item.id === projectId);
        if (projectId && !project) throw new Error('Unknown project.');
        const path = project?.path ?? join(this.root, 'workspaces', randomUUID());
        await mkdir(path, { recursive: true });
        return this.#command('runtime.create_session', { sessionId: key, metadata: { title: String(data.title || '新对话'), agentId: this.#state.id, projectId: project?.id ?? null, projectDir: project?.path ?? null }, workspace: { mode: 'direct', sourceDir: path } });
      }
      case 'sessions.rename': {
        const snapshot = decodeSessionSnapshot(await this.#command('runtime.get_session', { sessionId: sessionId() }));
        const title = z.string().trim().min(1).max(200).parse(data.title);
        await this.#write(state => { state.sessions ??= {}; state.sessions[snapshot.sessionId] = { ...state.sessions[snapshot.sessionId], title }; });
        return this.#present(snapshot);
      }
      case 'sessions.update': {
        const value = z.object({ sessionId: id, pinned: z.boolean().optional(), archived: z.boolean().optional(), readAt: z.string().datetime().optional(), forcedUnread: z.boolean().optional() }).strict().parse(data);
        const snapshot = decodeSessionSnapshot(await this.#command('runtime.get_session', { sessionId: value.sessionId }));
        const { sessionId: key, ...patch } = value;
        await this.#write(state => { state.sessions ??= {}; state.sessions[key] = { ...state.sessions[key], ...patch }; });
        return this.#present(snapshot);
      }
      case 'sessions.fork': {
        const sourceId = sessionId(); this.#idle(sourceId);
        const source = this.#present(decodeSessionSnapshot(await this.#command('runtime.get_session', { sessionId: sourceId })));
        const target = `session-${randomUUID()}`;
        const project = this.#state.projects.find(item => item.id === source.metadata?.projectId);
        const path = project?.path ?? join(this.root, 'workspaces', randomUUID());
        await mkdir(path, { recursive: true });
        await this.#command('runtime.create_session', { sessionId: target, metadata: { title: `${source.metadata?.title || 'Conversation'} · Fork`, agentId: this.#state.id, projectId: project?.id ?? null, projectDir: project?.path ?? null }, workspace: { mode: 'direct', sourceDir: path } });
        try { return await this.#command('runtime.fork_session', { sourceSessionId: sourceId, sessionId: target }); }
        catch (error) { await this.#command('runtime.delete_session', { sessionId: target }).catch(() => undefined); throw error; }
      }
      case 'sessions.delete': { this.#idle(sessionId()); const result = await this.#command('runtime.delete_session', { sessionId: sessionId() }); await this.#write(state => { if (state.sessions) delete state.sessions[sessionId()]; }); return result; }
      case 'sessions.bind': {
        this.#idle(sessionId());
        const project = this.#state.projects.find(item => item.id === data.projectId);
        if (!project && data.projectId !== null && data.projectId !== '') throw new Error('Unknown project.');
        const snapshot = decodeSessionSnapshot(await this.#command('runtime.get_session', { sessionId: sessionId() }));
        const taskDir = project ? undefined : join(this.root, 'workspaces', randomUUID());
        if (taskDir) await mkdir(taskDir, { recursive: true });
        return this.#command('runtime.switch_workspace', { sessionId: snapshot.sessionId, expectedRevision: snapshot.revision, projectDir: project?.path ?? null, projectId: project?.id ?? null, taskDir });
      }
      case 'delegation.submit': {
        const value = z.object({ taskId: id, sessionId: id, turnId: id, parentSessionId: id, parentTurnId: id,
          prompt: z.string().trim().min(1).max(1_000_000), permissionMode: sendSchema.shape.permissionMode, language: sendSchema.shape.language }).strict().parse(data);
        if (value.turnId !== `turn-${value.taskId}` || !value.sessionId.startsWith('delegated-')) throw new Error('Invalid delegated task identity.');
        const existing = this.#state.jobs.find(job => job.id === value.taskId);
        if (existing) {
          if (existing.sessionId !== value.sessionId || existing.turnId !== value.turnId || existing.input.text !== value.prompt || existing.input.permissionMode !== value.permissionMode || existing.input.language !== value.language || existing.delegation?.parentSessionId !== value.parentSessionId || existing.delegation?.parentTurnId !== value.parentTurnId) throw new Error('Delegation ID was already used for different content.');
          return publicJob(existing);
        }
        const models = await this.#product({ kind: 'models.get' }) as { defaultModelId: string };
        if (!models.defaultModelId) throw new Error('Configure a default model on the target Agent before delegating.');
        const snapshot = await this.#command('runtime.get_session', { sessionId: value.sessionId });
        if (!snapshot) {
          const project = this.#state.projects.find(item => item.id === this.#state.defaultProjectId);
          const path = project?.path ?? join(this.root, 'workspaces', randomUUID());
          await mkdir(path, { recursive: true });
          await this.#command('runtime.create_session', { sessionId: value.sessionId,
            metadata: { title: value.prompt.slice(0, 60), agentId: this.#state.id, projectId: project?.id ?? null, projectDir: project?.path ?? null, delegationOwner: value.parentSessionId },
            workspace: { mode: 'direct', sourceDir: path } });
        } else if (decodeSessionSnapshot(snapshot).metadata?.delegationOwner !== value.parentSessionId) throw new Error('This remote conversation belongs to another parent.');
        await this.#write(state => state.jobs.push({ id: value.taskId, sessionId: value.sessionId, turnId: value.turnId,
          input: { requestId: value.taskId, sessionId: value.sessionId, text: value.prompt, modelId: models.defaultModelId, permissionMode: value.permissionMode, language: value.language },
          delegation: { parentSessionId: value.parentSessionId, parentTurnId: value.parentTurnId }, createdAt: new Date().toISOString(), status: 'queued' }));
        this.#pump(); return publicJob(this.#state.jobs.find(job => job.id === value.taskId)!);
      }
      case 'chat.send': {
        const value = sendSchema.parse(data);
        if (!await this.#command('runtime.get_session', { sessionId: value.sessionId })) throw new Error('Unknown conversation.');
        await this.#write(state => {
          const existing = state.jobs.find(job => job.id === value.requestId);
          if (existing) { if (JSON.stringify(existing.input) !== JSON.stringify(value)) throw new Error('Request ID was already used for different content.'); return; }
          state.jobs.push({ id: value.requestId, sessionId: value.sessionId, turnId: value.turnId ?? `turn-${randomUUID()}`, input: value, createdAt: new Date().toISOString(), status: 'queued' });
        });
        this.#pump();
        return publicJob(this.#state.jobs.find(job => job.id === value.requestId)!);
      }
      case 'chat.queue': {
        const value = z.object({ action: z.enum(['remove', 'reorder', 'guide']), id, targetId: id.optional(), turnId: id.optional() }).strict().parse(data);
        const job = this.#state.jobs.find(item => item.id === value.id);
        if (!job) throw new Error('Unknown queued message.');
        if (value.action === 'guide' && job.guidance?.applied) return { accepted: true };
        if (job.status !== 'queued' || this.#assigned.get(job.sessionId) === job.id) throw new Error('This message has already started. Refresh before changing it.');
        if (job.guidance && value.action !== 'guide') throw new Error('Guidance delivery is pending. Retry delivery before changing this message.');
        if (value.action === 'remove') {
          await this.#write(state => { state.jobs.find(item => item.id === job.id)!.status = 'stopped'; });
        } else if (value.action === 'reorder') {
          await this.#write(state => {
            const from = state.jobs.findIndex(item => item.id === job.id);
            const targetIndex = state.jobs.findIndex(item => item.id === value.targetId);
            const target = state.jobs[targetIndex];
            if (!target || target.sessionId !== job.sessionId || target.status !== 'queued' || target.guidance || this.#assigned.get(target.sessionId) === target.id) throw new Error('Queue target is no longer available.');
            const [item] = state.jobs.splice(from, 1);
            state.jobs.splice(targetIndex, 0, item);
          });
        } else {
          const active = this.#state.jobs.find(item => item.sessionId === job.sessionId && item.status === 'running');
          if (!job.guidance && (!active || active.turnId !== value.turnId)) throw new Error('The target turn is no longer running.');
          // Reserve durably before delivery. A crash or an uncertain reply cannot
          // allow the queue pump to execute the same text as an ordinary turn.
          if (!job.guidance) await this.#write(state => { state.jobs.find(item => item.id === job.id)!.guidance = {
            turnId: active!.turnId, messageId: `queued-guidance-${job.id}`, createdAt: new Date().toISOString() }; });
          const reserved = this.#state.jobs.find(item => item.id === job.id)!;
          try {
            await this.#command('runtime.enqueue_guidance', { protocol: 'bush.runtime_guidance.v1', sessionId: job.sessionId,
              turnId: reserved.guidance!.turnId, messageId: reserved.guidance!.messageId, createdAt: reserved.guidance!.createdAt, content: job.input.text,
              ...(job.input.userMessageMetadata ? { metadata: job.input.userMessageMetadata } : {}) });
          } catch (error) {
            // These Runtime rejections occur only after durable duplicate lookup.
            // A definitively unaccepted append can safely return to the queue.
            if (['turn_not_active', 'turn_guidance_closed'].includes(String((error as { code?: string }).code))) {
              await this.#write(state => { delete state.jobs.find(item => item.id === job.id)!.guidance; });
              this.#pump();
            }
            throw error;
          }
          await this.#write(state => { const item = state.jobs.find(item => item.id === job.id)!; item.status = 'stopped'; item.guidance!.applied = true; });
        }
        this.#pump(); return { accepted: true };
      }
      case 'chat.jobs': return this.#state.jobs.filter(job => !data.sessionId || job.sessionId === data.sessionId).map(publicJob);
      case 'chat.stop': {
        const jobId = id.parse(data.id);
        const job = this.#state.jobs.find(item => item.id === jobId);
        if (!job) throw new Error('Unknown task.');
        if (this.#assigned.get(job.sessionId) === job.id) this.#busy.get(job.sessionId)?.abort();
        if (job.status === 'queued') await this.#write(state => { state.jobs.find(item => item.id === jobId)!.status = 'stopped'; });
        else if (job.status === 'running') { this.#busy.get(job.sessionId)?.abort(); await this.#command('runtime.stop_turn', { sessionId: job.sessionId, turnId: job.turnId }); }
        return { accepted: true };
      }
      case 'chat.events': return this.#events(data, readSignal);
      case 'conversation.extracts': {
        const store = await this.#extractStore();
        switch (z.enum(['list', 'preview', 'save', 'consume', 'resolve', 'read', 'remove', 'export']).parse(data.action)) {
          case 'list': return store.list();
          case 'preview': return store.preview(data.selection);
          case 'save': return store.save(data.selection, z.enum(['temporary', 'permanent', 'reference']).parse(data.kind));
          case 'consume': return store.consume(id.parse(data.id));
          case 'resolve': return store.resolve(id.parse(data.id), data.contextWindowTokens === undefined ? undefined : z.number().int().positive().parse(data.contextWindowTokens));
          case 'remove': return store.remove(id.parse(data.id));
          case 'read': {
            const item = await store.resolve(id.parse(data.id));
            return { name: `${item.title}.md`, content: await readFile(item.path, 'utf8') };
          }
          case 'export': {
            const selection = data.selection as { sessionId?: string };
            const session = await this.#command('runtime.get_session', { sessionId: id.parse(selection?.sessionId) }) as SessionSnapshot;
            const workspace = session.metadata?.runtimeWorkspace as { workspaceDir?: string } | undefined;
            if (!workspace?.workspaceDir) throw new Error('This session has no export directory.');
            return store.export(data.selection, async () => join(workspace.workspaceDir!, `conversation-${randomUUID()}.md`));
          }
        }
        return;
      }
      case 'runtime.command': {
        const kind = z.string().regex(/^(runtime|plugin)\./).parse(data.kind);
        // Execution always enters the service queue, not a transport-owned promise.
        if (/^runtime\.(run_|resume_|shutdown|upsert_provider|remove_provider|apply_mcp|prepare_plugin)/.test(kind)) throw new Error('Use the Agent service operation for this command.');
        if (kind === 'runtime.delete_session') this.#idle(id.parse((data.payload as Record<string, unknown>)?.sessionId));
        else if (/clear_sessions|switch_workspace|collect_cache|(?:revert|restore|update)_workspace/.test(kind)) this.#idle();
        return this.#command(kind, data.payload ?? {});
      }
      case 'product.command': if (String(data.kind).startsWith('maintenance.')) this.#idle(); return this.#product(data);
      case 'plugins.install': return installProductPlugin(z.string().min(1).parse(data.path), join(this.root, 'plugins'), (pluginId, replace) => this.product.replacePlugin(pluginId, replace)).then(async result => { await this.product.refreshMcp(); return result; });
      case 'plugins.uninstall': return this.product.uninstallPlugin(id.parse(data.id));
      case 'plugins.connections.save': return this.product.savePluginConnections(data);
      case 'plugins.connections': return this.product.listPluginConnections(typeof data.pluginId === 'string' ? data.pluginId : undefined);
      case 'plugins.configure': return this.product.configurePluginConnection(data);
      case 'mcp.list': return this.product.listMcpServers();
      case 'mcp.configure': return this.product.configureMcpServer(data as Parameters<ElectronProductHostController['configureMcpServer']>[0]);
      case 'mcp.remove': return this.product.removeMcpServer(id.parse(data.id));
      case 'mcp.reconnect': return this.product.reconnectMcpServer(id.parse(data.id));
      case 'instructions.get': return this.instructions.read();
      case 'instructions.save': return this.instructions.save(z.string().parse(data.content), z.string().parse(data.revision));
    }
  }

  #extracts?: Promise<import('./conversationExtracts.mjs').ConversationExtractStore>;
  #extractStore() {
    return this.#extracts ??= import('./conversationExtracts.mjs').then(({ ConversationExtractStore }) =>
      new ConversationExtractStore(join(this.root, 'conversation-extracts'), (sessionId, keys) =>
        this.#command('runtime.extract_session', { sessionId, keys }) as Promise<ConversationExtractSource>));
  }
  #pump() {
    if (this.#closing || this.#storageFailure) return;
    for (const job of this.#state.jobs) {
      if (job.status !== 'queued' || job.guidance || this.#busy.has(job.sessionId)) continue;
      const abort = new AbortController(); this.#busy.set(job.sessionId, abort);
      this.#assigned.set(job.sessionId, job.id);
      void this.#run(job.id, abort.signal).catch(error => {
        this.#storageFailure = `Agent task persistence failed: ${String(error)}`;
        for (const active of this.#busy.values()) active.abort();
        process.stderr.write(this.#storageFailure + '\n');
      })
        .finally(() => { this.#busy.delete(job.sessionId); this.#assigned.delete(job.sessionId); this.#pump(); });
    }
  }
  async #run(jobId: string, signal: AbortSignal) {
    await this.#write(state => { const job = state.jobs.find(item => item.id === jobId)!; if (job.status === 'queued') { job.status = 'running'; job.startedAt = new Date().toISOString(); } });
    const job = this.#state.jobs.find(item => item.id === jobId)!;
    if (job.status !== 'running') return;
    try {
      signal.throwIfAborted();
      const snapshot = decodeSessionSnapshot(await this.#command('runtime.get_session', { sessionId: job.sessionId }));
      const selected = await this.product.resolveSubagentModel(job.input.modelId) as { model: string; binding: RuntimeProviderBindingRef; maxContextTokens?: number; maxOutputTokens?: number };
      const catalog = await this.#command('runtime.get_tool_catalog') as ToolDefinition[];
      const workspace = snapshot.metadata?.runtimeWorkspace as { workspaceDir?: string; sourceDir?: string } | undefined;
      const projectDir = typeof snapshot.metadata?.projectDir === 'string' ? snapshot.metadata.projectDir : undefined;
      const workspaceDir = workspace?.workspaceDir || workspace?.sourceDir || projectDir;
      if (job.input.goalObjective) await this.#command('runtime.create_goal', { goalId: `goal-${job.id}`, sessionId: job.sessionId, objective: job.input.goalObjective });
      const activeGoal = await this.#command('runtime.get_goal', { sessionId: job.sessionId }) as { status: string } | null;
      if (job.goalContinuation && activeGoal?.status !== 'active') {
        await this.#write(state => { const current = state.jobs.find(item => item.id === jobId)!; current.status = 'stopped'; current.completedAt = new Date().toISOString(); });
        return;
      }
      const request = createProductAgentTurnRequest({
        requestId: job.id, sessionId: job.sessionId, turnId: job.turnId, messageId: `message-${job.id}`, createdAt: job.createdAt,
        userText: job.input.text, userMessageName: job.goalContinuation ? 'goal_continuation' : job.input.goalObjective ? 'goal_request' : undefined,
        conversationStyle: job.input.conversationStyle, files: job.input.files, images: job.input.images, visionEnabled: job.input.visionEnabled, userMessageMetadata: job.input.userMessageMetadata, uiLanguage: job.input.language, model: selected.model, providerBinding: selected.binding,
        maxContextTokens: selected.maxContextTokens, maxOutputTokens: selected.maxOutputTokens,
        tools: catalog.filter(tool => tool.name !== 'update_goal' || activeGoal?.status === 'active'), projectDir, workspaceDir,
        instructionDocuments: await readAgentInstructionDocuments(this.instructions, projectDir ?? workspaceDir, workspaceDir),
        teamInstructions: 'This is an independent headless CardBush Agent. Paths and tools belong to this server. Desktop mouse control and graphical browser control are unavailable. Never imply access to the connecting user’s computer.',
        permissionMode: job.input.permissionMode, planEnabled: job.input.planEnabled ?? true, interactiveRequestsEnabled: true,
        reasoningEffort: job.input.reasoningEffort, disabledSkills: job.input.disabledSkills, subagentPermissionRouting: job.input.subagentPermissionRouting,
        sessionTitle: String(snapshot.metadata?.title ?? ''),
      });
      if (job.input.supersession) request.supersession = job.input.supersession;
      if (job.delegation) request.metadata = { ...request.metadata, agentRole: 'child', disabledTools: [...DEFAULT_CHILD_AGENT_DISABLED_TOOLS],
        remoteDelegation: job.delegation };
      signal.throwIfAborted();
      // Wait for the Runtime's actual terminal result before dequeuing another
      // message. Cancelling the RPC promise itself would release this queue early.
      const result = await this.runtime.runOwnedCommand({ kind: 'runtime.run_session_turn', payload: request }, signal) as { payload: { status: string; reason: string } };
      await this.#write(state => { const current = state.jobs.find(item => item.id === jobId)!;
        current.status = result.payload.status === 'completed' ? 'completed' : result.payload.status === 'stopped' ? 'stopped' : 'failed';
        current.completedAt = new Date().toISOString(); if (current.status === 'failed') current.error = result.payload.reason;
      });
      const goal = await this.#command('runtime.get_goal', { sessionId: job.sessionId }) as { status: string } | null;
      if (!signal.aborted && goal?.status === 'active' && result.payload.status === 'completed' && result.payload.reason !== 'task_plan_waiting') {
        const requestId = randomUUID();
        await this.#write(state => {
          // A user's queued message is the next turn. That turn can schedule
          // continuation afterward; never insert automatic work ahead of it.
          if (signal.aborted || state.jobs.some(item => item.sessionId === job.sessionId && item.status === 'queued' && !item.guidance)) return;
          state.jobs.push({
            id: requestId, sessionId: job.sessionId, turnId: `turn-${randomUUID()}`, createdAt: new Date().toISOString(), status: 'queued', goalContinuation: true,
            input: { ...job.input, requestId, text: GOAL_CONTINUATION_PROMPT, goalObjective: undefined, supersession: undefined, turnId: undefined, files: undefined, images: undefined,
              userMessageMetadata: job.input.userMessageMetadata?.userTimeZone ? { userTimeZone: job.input.userMessageMetadata.userTimeZone } : undefined },
          });
        });
      }
    } catch (error) {
      await this.#write(state => { const current = state.jobs.find(item => item.id === jobId)!; current.status = signal.aborted ? 'stopped' : 'failed'; current.completedAt = new Date().toISOString(); current.error = error instanceof Error ? error.message : String(error); });
    }
  }
  eventStream(input: unknown, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (this.#closing) throw new Error('Agent is shutting down.');
    const request = z.object({ sessionId: id, turnId: id, afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict().parse(input);
    if (!this.#state.jobs.some(job => job.sessionId === request.sessionId && job.turnId === request.turnId)) throw new Error('Unknown Agent task.');
    return this.#streamEvents(request, signal);
  }
  async *#streamEvents(request: AgentEventRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    const settled = () => !this.#state.jobs.some(job => job.sessionId === request.sessionId && job.turnId === request.turnId && ['queued', 'running'].includes(job.status));
    const changed = () => { if (settled()) abort.abort(); };
    let cursor = request.afterSequence;
    this.#stateListeners.add(changed);
    try {
      if (!settled()) {
        try {
          for await (const value of this.runtime.transport.openEventStream({ sessionId: request.sessionId, turnId: request.turnId,
            cursor: cursor === undefined ? undefined : { afterSequence: cursor }, signal: combined })) {
            const event = value as RuntimeEvent; cursor = event.sequence; yield event;
          }
        } catch (error) { if (!combined.aborted) throw error; }
      }
      if (!signal.aborted) {
        // A job may stop before entering the Runtime, or fail without a terminal
        // event. Once settled, replay the remaining durable facts and close.
        const remaining = await this.#command('runtime.list_turn_events', { sessionId: request.sessionId, turnId: request.turnId,
          ...(cursor === undefined ? {} : { afterSequence: cursor }) }) as RuntimeEvent[];
        for (const event of remaining) { if (signal.aborted) return; yield event; }
      }
    } finally { this.#stateListeners.delete(changed); abort.abort(); }
  }
  async #events(data: Record<string, unknown>, readSignal?: AbortSignal) {
    const request = z.object({ sessionId: id, turnId: id, afterSequence: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(25_000).default(20_000), limit: z.number().int().min(1).max(200).default(100) }).parse(data);
    const abort = new AbortController(); const events: RuntimeEvent[] = [];
    const signal = readSignal ? AbortSignal.any([readSignal, abort.signal]) : abort.signal;
    let ended = false;
    const timer = setTimeout(() => abort.abort(), Math.max(30, request.waitMs));
    let flush: ReturnType<typeof setTimeout> | undefined;
    try {
      for await (const input of this.runtime.transport.openEventStream({ sessionId: request.sessionId, turnId: request.turnId, cursor: request.afterSequence === undefined ? undefined : { afterSequence: request.afterSequence }, signal })) {
        const event = input as RuntimeEvent; events.push(event);
        if (event.kind === 'turn_terminal') { ended = true; break; }
        if (events.length >= request.limit) break;
        flush ??= setTimeout(() => abort.abort(), 30);
      }
    } catch (error) { if (!signal.aborted) throw error; }
    finally { clearTimeout(timer); clearTimeout(flush); abort.abort(); }
    return { events, afterSequence: events.at(-1)?.sequence ?? request.afterSequence ?? null, ended };
  }
  async close() {
    if (this.#closing) return; this.#closing = true;
    await this.#mutations;
    await this.#marketplaces.close();
    for (const abort of this.#busy.values()) abort.abort();
    await this.runtime.close();
    if (this.#extracts) (await this.#extracts).close();
    while (this.#busy.size) await new Promise(resolve => setTimeout(resolve, 10));
    await this.#writes; await this.#releaseLock();
  }
}
function publicJob({ input, ...job }: AgentJob) { return { ...job, text: input.text, modelId: input.modelId }; }
