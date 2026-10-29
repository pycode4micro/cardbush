import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { remoteControlSchema, remoteObservationSchema, remoteWorkerSchema, supportsRemoteInteraction, type RemoteSubagentRequest, type SessionSnapshot } from '@cardbush/bush-protocol';
import type { AgentJob } from './agentTypes.js';
import type { WebStore } from './webStore.mjs';
import { equalSecret, json, readJson, WebError } from './webCommon.mjs';
import { remoteAgentToken, remoteIdentity, WebRemoteAgents } from './webRemoteAgents.mjs';
import { runRemoteSubagent } from './remoteSubagent.mjs';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const common = { connectionId: id, agentId: id.optional(), parentSessionId: id, sessionId: id };
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('agents.list'), input: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('agents.delegate'), input: z.object({ ...common, taskId: id, turnId: id, parentTurnId: id,
    prompt: z.string().min(1).max(100_000), queue: z.boolean().optional(), worker: remoteWorkerSchema.optional(), permissionMode: z.enum(['task_free', 'user_free', 'all_free']), language: z.string().trim().min(1).max(64).refine(value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }, 'Invalid language tag') }).strict() }).strict(),
  z.object({ operation: z.literal('agents.control'), input: z.object({ connectionId: id, agentId: id, parentSessionId: id,
    worker: remoteWorkerSchema.optional(), control: remoteControlSchema }).strict().transform(value => ({ ...value, sessionId: value.control.contextId })) }).strict(),
  z.object({ operation: z.literal('agents.read-child'), input: z.object(common).strict() }).strict(),
  z.object({ operation: z.literal('agents.guide-child'), input: z.object({ ...common, turnId: id, messageId: id, content: z.string().min(1).max(100_000) }).strict() }).strict(),
]);
/** The tenant can request only the listed delegation operations. It never receives a remote
 * credential, arbitrary RPC, configuration sync, shell or provisioning endpoint. */
export class WebRemoteAgentBridge {
  readonly #active = new Map<string, number>();
  constructor(readonly registry: WebRemoteAgents, readonly store: WebStore) {}
  async handle(request: IncomingMessage, response: ServerResponse, path: string, signal: AbortSignal) {
    const match = path.match(/^\/internal\/remote-agents\/([A-Za-z0-9_-]+)$/);
    if (!match || request.method !== 'POST' || request.headers.origin !== undefined) throw new WebError(404, 'Not found.');
    const userId = match[1], secret = this.registry.secret;
    if (!equalSecret(request.headers.authorization ?? '', `Bearer ${remoteAgentToken(secret, userId)}`)) throw new WebError(401, 'Unauthorized.');
    if (!(await this.store.user(userId))?.is_active) throw new WebError(401, 'Account is inactive.');
    const { operation, input } = requestSchema.parse(await readJson(request, 450_000));
    if (operation === 'agents.list') { json(response, 200, await this.registry.list(userId)); return; }
    await this.store.conversation(userId, input.parentSessionId);
    const connection = await this.registry.authorized(userId, input.connectionId);
    if (input.agentId && input.agentId !== connection.agentId) throw new WebError(409, '远程 Agent 身份已改变。');
    if (!input.sessionId.startsWith('delegated-')) throw new WebError(400, 'Invalid delegated session.');
    const parentSessionId = 'webparent_' + remoteIdentity(secret, userId, input.parentSessionId);
    const sessionId = 'delegated-web-' + remoteIdentity(secret, userId, input.parentSessionId, connection.id, input.sessionId);
    const taskIdFor = (task: string) => 'webtask_' + remoteIdentity(secret, userId, input.parentSessionId, connection.id, task);
    const running = this.#active.get(userId) ?? 0;
    if (operation === 'agents.delegate' && (running >= 4 || [...this.#active.values()].reduce((a, b) => a + b, 0) >= 16))
      throw new WebError(429, '远程子任务并发已满，请先等待已有任务完成。');
    if (operation === 'agents.delegate') this.#active.set(userId, running + 1);
    const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
    let client: Awaited<ReturnType<WebRemoteAgents['clientFactory']>> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let validating = false;
    try {
      client = await this.registry.clientFactory(connection);
      const info = await client.info();
      if (info.id !== connection.agentId || !info.capabilities.delegation) throw new WebError(409, '远程 Agent 身份或委派能力已改变。');
      const readOwned = async () => {
        const session = await client!.call('sessions.get', { sessionId }) as SessionSnapshot | undefined;
        if (session?.metadata?.delegationOwner !== parentSessionId) throw new WebError(403, '远程子会话不属于当前账号和会话。');
        return session;
      };
      if (operation === 'agents.control') {
        if (!supportsRemoteInteraction(info.capabilities.workerInteraction)) throw new WebError(409, 'Update the remote worker to support interaction.');
        const session = await readOwned(), control = input.control;
        const taskId = taskIdFor(id.parse(control.taskId));
        if (control.operation === 'message' && control.delivery === 'queue') {
          // Allocate a tenant-visible handle that can be observed after reconnecting.
          const jobs = await client.call('chat.jobs', { sessionId }) as Array<AgentJob & { permissionMode?: string; language?: string }>;
          const original = jobs.find(job => job.id === taskId && job.delegation?.parentSessionId === parentSessionId);
          if (!original) throw new WebError(404, 'Unknown owned worker task.');
          const nextId = 'queued-' + remoteIdentity(secret, userId, input.parentSessionId, connection.id, control.messageId);
          const nextTaskId = taskIdFor(nextId);
          const queued = await client.call('delegation.submit', { taskId: nextTaskId, sessionId, turnId: `turn-${nextTaskId}`,
            parentSessionId, parentTurnId: original.delegation!.parentTurnId, prompt: control.text, queue: true,
            permissionMode: original.permissionMode ?? 'task_free', language: original.language ?? 'en', worker: session.metadata?.remoteWorker }) as AgentJob;
          json(response, 200, { accepted: true, contextId: input.sessionId, taskId: nextId, state: queued.status }); return;
        }
        const mapped = { ...control, contextId: sessionId, taskId, ...('messageId' in control ? {
          messageId: 'webcontrol_' + remoteIdentity(secret, userId, input.parentSessionId, connection.id, control.messageId) } : {}) };
        const result = await client.call('delegation.control', { parentSessionId, control: mapped }, combined);
        await this.registry.authorized(userId, input.connectionId);
        if (!(await this.store.user(userId))?.is_active) throw new WebError(401, 'Account is inactive.');
        if (control.operation === 'observe') {
          const observation = remoteObservationSchema.parse(result);
          if (observation.contextId !== sessionId || observation.taskId !== taskId) throw new WebError(502, 'Remote worker identity changed.');
          json(response, 200, { ...observation, contextId: input.sessionId, taskId: control.taskId,
            interactions: observation.interactions.map(item => ({ ...item, contextId: input.sessionId, taskId: control.taskId })) });
        } else json(response, 200, result);
        return;
      }
      if (operation === 'agents.read-child') {
        const session = await readOwned();
        // Parent conversation readers need only inputs and final replies.
        // Do not relay remote provider configuration, images, tool payloads or paths in metadata.
        json(response, 200, { sessionId: input.sessionId, supersededMessageIds: session.supersededMessageIds,
          turns: session.turns.map(turn => {
            const candidate = [...turn.messages].reverse().find(entry => entry.message.role === 'assistant' && entry.metadata?.runtimeMaintenance !== 'context_compaction');
            const final = turn.status === 'completed' && candidate?.message.role === 'assistant' && !candidate.message.toolCalls?.length ? candidate : undefined;
            return { turnId: turn.turnId, status: turn.status, messages: turn.messages
              .filter(entry => entry.message.role === 'user' || entry === final)
              .map(entry => ({ messageId: entry.messageId, turnId: entry.turnId, createdAt: entry.createdAt,
                metadata: { subagentAuthor: entry.metadata?.subagentAuthor, runtimeMaintenance: entry.metadata?.runtimeMaintenance },
                message: { role: entry.message.role, content: entry.message.content, ...('name' in entry.message ? { name: entry.message.name } : {}),
                  ...('visibility' in entry.message ? { visibility: entry.message.visibility } : {}),
                  ...(entry.message.role === 'assistant' ? { toolCalls: [] } : {}) } })) };
          }) }); return;
      }
      if (operation === 'agents.guide-child') {
        const session = await readOwned();
        if (!input.turnId.startsWith('turn-')) throw new WebError(400, 'Invalid delegated turn.');
        const turnId = 'turn-' + taskIdFor(input.turnId.slice(5));
        if (!session.turns.some(turn => turn.turnId === turnId)) throw new WebError(404, '远程子任务不存在。');
        json(response, 200, await client.call('runtime.command', { kind: 'runtime.enqueue_guidance', payload: {
          protocol: 'bush.runtime_guidance.v1', sessionId, turnId, messageId: 'webguide_' + remoteIdentity(secret, userId, input.parentSessionId, input.messageId),
          content: input.content, createdAt: new Date().toISOString(), mode: 'append_context',
          metadata: { subagentAuthor: 'parent', realtimeParent: true },
        } })); return;
      }
      if (input.turnId !== `turn-${input.taskId}`) throw new WebError(400, 'Invalid delegated task.');
      const taskId = taskIdFor(input.taskId);
      const delegated: RemoteSubagentRequest = { ...input, agentId: connection.agentId, taskId, sessionId,
        turnId: `turn-${taskId}`, parentSessionId, parentTurnId: 'webturn_' + remoteIdentity(secret, userId, input.parentTurnId),
        // The receiver intersects this request with its own host ceiling.
        permissionMode: input.permissionMode };
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }); response.flushHeaders();
      timer = setInterval(() => {
        if (!response.destroyed) response.write('{"type":"heartbeat"}\n');
        if (validating) return;
        validating = true;
        void (async () => {
          if (!(await this.store.user(userId))?.is_active) throw new Error('Account is inactive.');
          const current = await this.registry.authorized(userId, connection.id);
          if (current.agentId !== connection.agentId || current.url !== connection.url || current.token !== connection.token ||
              current.transport !== connection.transport || JSON.stringify(current.ssh) !== JSON.stringify(connection.ssh)) throw new Error('Agent access changed.');
          await this.store.conversation(userId, input.parentSessionId);
        })().catch(() => abort.abort()).finally(() => { validating = false; });
      }, 10_000);
      const remote = client;
      const result = await runRemoteSubagent({
        connect: async () => info,
        call: (_id, operation, value, signal) => remote.call(operation, value, signal),
        events: (_id, input, signal) => remote.events(input, signal),
      }, delegated, combined);
      response.end(JSON.stringify({ type: 'result', value: result }) + '\n');
    } catch (error) {
      if (response.headersSent) {
        const message = error instanceof Error && error.message.includes('cancellation could not be confirmed')
          ? '远程任务是否停止尚未确认，请先在远程服务确认状态，避免重复执行。'
          : '远程子任务连接中断或执行失败，请查看任务状态后重试。';
        if (!response.destroyed) response.end(JSON.stringify({ type: 'error', error: message }) + '\n');
      } else if (error instanceof WebError) throw error;
      else throw new WebError(502, '远程 Agent 暂不可用，请检查连接或联系管理员。');
    } finally {
      if (timer) clearInterval(timer); client?.close();
      if (operation === 'agents.delegate') {
        const count = (this.#active.get(userId) ?? 1) - 1;
        if (count) this.#active.set(userId, count); else this.#active.delete(userId);
      }
    }
  }
}
