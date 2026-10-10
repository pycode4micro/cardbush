import { webToolAllowed, normalizeWebImage } from '@cardbush/bush-runtime/web-policy';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, extname, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { BrokerWebAgents, type WebAgents, type WebAgent } from './webAgentPool.mjs';
import { PostgresWebStore, type WebStore } from './webStore.mjs';
import { cookie, csrfToken, digest, equalSecret, json, imageToken, modelToken, readJson, WebError, type WebModel, type WebUser } from './webCommon.mjs';

export type WebServerConfig = { origin: string; port?: number; host?: string; staticRoot: string; modelSecret: string; models: WebModel[]; defaultModelId: string; imageModel?: { model: string; baseURL: string; apiKey: string } };
type Job = { id: string; sessionId: string; turnId: string; status: string; text: string; modelId: string; error?: string };
const prefix = '/api/web/v1';
const visibleEvents = new Set(['turn_accepted', 'turn_started', 'assistant_segment_started', 'assistant_segment_delta', 'assistant_segment_completed', 'turn_terminal', 'model_request_usage', 'guidance_applied', 'tool_queued', 'tool_running', 'tool_returned', 'tool_failed', 'tool_cancelled', 'solution_selection_requested', 'solution_selection_answered', 'solution_selection_cancelled', 'context_compaction_started', 'context_compaction_completed']);
const messageSchema = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(100_000), modelId: z.string().min(1).max(160), attachments: z.array(z.string().uuid()).max(8).default([]) }).strict();

/** This is an authenticated web application, not a proxy for the owner API.
 * The authenticated account selects the runtime; every session route also checks
 * its durable ownership record before touching that runtime. */
export async function serveWeb(config: WebServerConfig, store: WebStore, agents: WebAgents) {
  const publicOrigin = new URL(config.origin).origin;
  if (publicOrigin !== config.origin || config.modelSecret.length < 48) throw new Error('Invalid web origin or model secret.');
  if (!config.models.some(model => model.id === config.defaultModelId)) throw new Error('A configured default model is required.');
  const active = new Set<{ token: string; userId: string; abort: AbortController }>();
  const throttles = new Map<string, { count: number; until: number }>();
  const mutations = new Map<string, Promise<unknown>>();
  const serial = async <T,>(key: string, work: () => Promise<T>) => {
    const operation = (mutations.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    mutations.set(key, operation);
    try { return await operation; } finally { if (mutations.get(key) === operation) mutations.delete(key); }
  };
  function throttle(key: string, limit: number) {
    if (throttles.size > 5000) for (const [id, value] of throttles) if (value.until < Date.now()) throttles.delete(id);
    const record = throttles.get(key);
    const value = !record || record.until < Date.now() ? { count: 0, until: Date.now() + 600_000 } : record;
    throttles.set(key, value); if (++value.count > limit) throw new WebError(429, '尝试过于频繁，请稍后重试。');
  }
  function setCookie(response: ServerResponse, token: string) {
    response.setHeader('Set-Cookie', `cardbush_web=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 86400 : 0}${publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
  }
  function identity(user: WebUser, token: string) {
    return { user, csrf: csrfToken(token), toolsEnabled: true, defaultModelId: config.defaultModelId,
      models: config.models.map(({ id, name }) => ({ id, name })) };
  }
  function requireOrigin(request: IncomingMessage) {
    if (request.headers.origin !== publicOrigin) throw new WebError(403, '请求来源不受信任。');
  }
  async function jobs(agent: WebAgent, sessionId: string) { return await agent.call('chat.jobs', { sessionId }) as Job[]; }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const abort = new AbortController(); response.once('close', () => abort.abort());
    void (async () => {
      const url = new URL(request.url ?? '/', publicOrigin), path = url.pathname;
      const method = request.method ?? 'GET';
      if (path === '/healthz' && method === 'GET') { json(response, 200, { ok: true, service: 'cardbush-web', toolsEnabled: true }); return; }
      if (path.startsWith('/internal/image/')) { await proxyImage(request, response, url, config, store, abort.signal); return; }
      if (path.startsWith('/internal/model/')) {
        await proxyModel(request, response, url, config, store, abort.signal); return;
      }
      if (!path.startsWith(`${prefix}/`)) {
        if (path.startsWith('/api/') || path.startsWith('/internal/')) throw new WebError(404, '接口不存在。');
        if (method !== 'GET' && method !== 'HEAD') throw new WebError(405, '请求方式不支持。');
        const asset = path === '/' || !extname(path) ? 'index.html' : decodeURIComponent(path).slice(1);
        const root = await realpath(config.staticRoot);
        const file = await realpath(join(root, asset)).catch(() => { throw new WebError(404, '页面不存在。'); });
        const rel = relative(root, file); if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new WebError(404, '页面不存在。');
        const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream';
        response.setHeader('Content-Type', contentType);
        if (path.startsWith('/assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        response.end(method === 'HEAD' ? undefined : await readFile(file)); return;
      }
      if (request.headers.origin && request.headers.origin !== publicOrigin) throw new WebError(403, '请求来源不受信任。');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new WebError(403, '请求来源不受信任。');
      if (!['GET', 'HEAD'].includes(method)) requireOrigin(request);
      if (path === `${prefix}/auth/departments` && method === 'GET') { json(response, 200, await store.departments()); return; }
      if ([`${prefix}/auth/login`, `${prefix}/auth/register`].includes(path) && method === 'POST') {
        const body = await readJson(request, 8192);
        const peer = request.socket.remoteAddress ?? 'unknown';
        throttle(`auth-ip:${peer}`, 120); throttle(`auth:${peer}:${String(body.username).toLowerCase()}`, 15);
        if (path.endsWith('/register')) { json(response, 201, await store.register(body)); return; }
        const result = await store.login(body);
        const previous = cookie(request);
        if (previous) { await store.logout(previous); for (const entry of active) if (entry.token === digest(previous)) entry.abort.abort(); }
        setCookie(response, result.token); json(response, 200, identity(result.user, result.token)); return;
      }
      const token = cookie(request), user = await store.authenticate(token);
      if (!user) { setCookie(response, ''); throw new WebError(401, '请登录后继续。'); }
      if (request.headers['x-cardbush-user'] && request.headers['x-cardbush-user'] !== user.id) throw new WebError(401, '账号已切换，请重新打开对话。');
      if (!['GET', 'HEAD'].includes(method) && !equalSecret(String(request.headers['x-csrf-token'] ?? ''), csrfToken(token))) throw new WebError(403, '会话校验失败，请刷新页面。');
      const track = { token: digest(token), userId: user.id, abort }; active.add(track);
      response.once('close', () => active.delete(track));
      if (path === `${prefix}/auth/me` && method === 'GET') { json(response, 200, identity(user, token)); return; }
      if (path === `${prefix}/auth/logout` && method === 'POST') {
        await store.logout(token); setCookie(response, ''); json(response, 200, { ok: true });
        for (const entry of active) if (entry !== track && entry.token === track.token) entry.abort.abort(); return;
      }
      if (path === `${prefix}/admin/users` && method === 'GET') {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。'); json(response, 200, await store.users(url.searchParams.get('deleted') === '1')); return;
      }
      if (path === `${prefix}/admin/users` && method === 'POST') {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        json(response, 201, await store.createUser(user, await readJson(request,8192))); return;
      }
      if (path === `${prefix}/admin/organization` && method === 'GET') {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        json(response, 200, await store.organization()); return;
      }
      const organization = path.match(/^\/api\/web\/v1\/admin\/(companies|departments)(?:\/([^/]+))?$/);
      if (organization) {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        const [,kind,encodedId] = organization, id = encodedId ? decodeURIComponent(encodedId) : null;
        if (method === 'GET') {
          const records = (await store.organization())[kind as 'companies' | 'departments'];
          const result = id ? records.find(record => record.id === id) : records;
          if (!result) throw new WebError(404, '组织不存在。'); json(response,200,result); return;
        }
        if ((method === 'POST' && !id) || (method === 'PATCH' && id)) {
          const input = await readJson(request,4096);
          const result = kind === 'companies' ? await store.saveCompany(user,id,input) : await store.saveDepartment(user,id,input);
          json(response,id ? 200 : 201,result); return;
        }
        if (method === 'DELETE' && id) {
          if (kind === 'companies') await store.deleteCompany(user,id); else await store.deleteDepartment(user,id);
          json(response,200,{deleted:true}); return;
        }
        throw new WebError(405, '请求方式不支持。');
      }
      const adminUser = path.match(/^\/api\/web\/v1\/admin\/users\/([^/]+)$/);
      if (adminUser && ['GET','DELETE'].includes(method)) {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        const id = decodeURIComponent(adminUser[1]);
        if (method === 'GET') {
          const result = await store.user(id,true); if (!result) throw new WebError(404, '账号不存在。'); json(response,200,result);
        } else {
          await store.deleteUser(user,id);
          for (const entry of active) if (entry !== track && entry.userId === id) entry.abort.abort();
          json(response,200,{deleted:true});
        }
        return;
      }
      const restoreUser = path.match(/^\/api\/web\/v1\/admin\/users\/([^/]+)\/restore$/);
      if (restoreUser && method === 'POST') {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        json(response,200,await store.restoreUser(user,decodeURIComponent(restoreUser[1]))); return;
      }
      if (adminUser && method === 'PATCH') {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        const input = await readJson(request, 8192), id = decodeURIComponent(adminUser[1]);
        const previous = await store.user(id);
        const updated = await store.updateUser(user, id, input);
        if (!updated.is_active || input.new_password || updated.username !== previous?.username || updated.role !== previous?.role) {
          for (const entry of active) if (entry !== track && entry.userId === id) entry.abort.abort();
        }
        json(response, 200, updated); return;
      }
      if (path === `${prefix}/plugins` && method === 'GET') { json(response, 200, { imageEnabled: await store.imageAllowed(user.id) }); return; }
      if (path === `${prefix}/admin/plugins` && ['GET','POST'].includes(method)) {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        json(response, 200, method === 'GET' ? await store.plugin() : await store.updatePlugin(user, await readJson(request, 1024))); return;
      }
      const grant = path.match(/^\/api\/web\/v1\/admin\/plugins\/volcengine_images\/users\/([^/]+)$/);
      if (grant && method === 'PUT') {
        if (user.role !== 'admin') throw new WebError(403, '需要管理员权限。');
        const input = z.object({ enabled: z.boolean() }).strict().parse(await readJson(request, 1024));
        json(response, 200, await store.grantPlugin(user, decodeURIComponent(grant[1]), input.enabled)); return;
      }
      if (path === `${prefix}/files` && method === 'POST') {
        throttle(`upload:${user.id}`, 1500);
        const input = z.object({ uploadId: z.string().uuid(), name: z.string().max(160), offset: z.number().int().min(0).max(16*1024*1024), size: z.number().int().min(1).max(16*1024*1024), content: z.string().max(710000), done: z.boolean() }).strict().parse(await readJson(request, 720000));
        const agent = await agents.get(user.id);
        try { json(response, 200, await agent.call('web.files', { action: 'upload', ...input })); }
        catch { throw new WebError(400, '上传未完成或文件不受支持。仅接受静态 PNG/JPG/WebP、UTF-8 文本、PDF 和无视频/宏的 Office 文档，单个文件不超过 16 MB。'); } return;
      }
      if (path === `${prefix}/files/view` && method === 'GET') {
        const filePath = z.string().min(1).max(1000).parse(url.searchParams.get('path'));
        const agent = await agents.get(user.id);
        let first: any;
        try { first = await agent.call('web.files', { action: 'read', path: filePath, offset: 0 }); } catch { throw new WebError(404, '文件不存在。'); }
        response.writeHead(200, { 'Content-Type': first.mime, 'Content-Length': first.size, 'Content-Disposition': `${first.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(first.name)}` });
        let chunk = first;
        while (true) {
          abort.signal.throwIfAborted();
          const bytes = Buffer.from(chunk.content, 'base64');
          if (!response.write(bytes)) await once(response, 'drain', { signal: abort.signal });
          if (chunk.done) break;
          chunk = await agent.call('web.files', { action: 'read', path: filePath, offset: chunk.offset + bytes.length });
        }
        response.end(); return;
      }
      if (path === `${prefix}/sessions` && method === 'GET') { json(response, 200, await store.list(user.id)); return; }
      if (path === `${prefix}/sessions` && method === 'POST') {
        const input = z.object({ requestId: z.string().uuid() }).strict().parse(await readJson(request, 1024));
        const id = `web-${digest(`${user.id}:${input.requestId}`).slice(0, 40)}`;
        const conversation = await serial(`${user.id}:${id}`, async () => {
          const agent = await agents.get(user.id);
          const existing = await agent.call('sessions.get', { sessionId: id, messageProjection: 'conversation' });
          if (!existing) await agent.call('sessions.create', { sessionId: id, title: '新对话' });
          return store.create(user.id, id, '新对话');
        });
        json(response, 201, conversation); return;
      }
      const match = path.match(/^\/api\/web\/v1\/sessions\/(web-[a-f0-9]{40})(?:\/(messages|events|jobs|solutions|tools)(?:\/([^/]+)\/(stop))?)?$/);
      if (!match) throw new WebError(404, '接口不存在。');
      const [, sessionId, action, jobId] = match;
      const conversation = await store.conversation(user.id, sessionId);
      // Account authorization and ownership are settled before runtime startup.
      const agent = await agents.get(user.id);
      if (!action && method === 'GET') {
        const [snapshot, taskList, solutions] = await Promise.all([agent.call('sessions.get', { sessionId, messageProjection: 'conversation' }), jobs(agent, sessionId), agent.call('runtime.command', { kind: 'runtime.list_solution_selections', payload: { sessionId } })]);
        const turns = (snapshot as { turns?: Array<{ turnId: string; messages: Array<{ message: { toolCalls?: unknown[] } }> }> } | null)?.turns ?? [];
        const toolTurns = turns.filter(turn => turn.messages.some(entry => entry.message.toolCalls?.length));
        const toolExecutions: unknown[] = [];
        // Summaries are small and immutable. Bound concurrent runtime reads on long conversations.
        for (let start = 0; start < toolTurns.length; start += 8) {
          const groups = await Promise.all(toolTurns.slice(start, start + 8).map(turn => agent.call('runtime.command', {
            kind: 'runtime.list_turn_tool_executions', payload: { sessionId, turnId: turn.turnId, detail: 'summary' },
          }) as Promise<unknown[]>));
          toolExecutions.push(...groups.flat());
        }
        json(response, 200, { conversation, snapshot, jobs: taskList, solutions, toolExecutions }); return;
      }
      if (action === 'tools' && method === 'GET') {
        const turnId = z.string().min(1).max(160).parse(url.searchParams.get('turnId'));
        const snapshot = await agent.call('sessions.get', { sessionId, messageProjection: 'conversation' }) as { turns?: Array<{ turnId: string }> } | null;
        if (!snapshot?.turns?.some(turn => turn.turnId === turnId) && !(await jobs(agent, sessionId)).some(job => job.turnId === turnId)) throw new WebError(404, '执行记录不存在。');
        json(response, 200, await agent.call('runtime.command', { kind: 'runtime.list_turn_tool_executions', payload: { sessionId, turnId } })); return;
      }
      if (!action && method === 'PATCH') {
        const input = z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict().parse(await readJson(request, 4096));
        if (input.title) await agent.call('sessions.rename', { sessionId, title: input.title });
        if (input.pinned !== undefined || input.archived !== undefined) await agent.call('sessions.update', { sessionId, ...(input.pinned !== undefined ? { pinned: input.pinned } : {}), ...(input.archived !== undefined ? { archived: input.archived } : {}) });
        json(response, 200, await store.update(user.id, sessionId, input)); return;
      }
      if (!action && method === 'DELETE') { await agent.call('sessions.delete', { sessionId }); await store.remove(user.id, sessionId); json(response, 200, { deleted: true }); return; }
      if (action === 'solutions' && method === 'POST') {
        const input = z.object({ selectionId: z.string().max(160), turnId: z.string().max(160), kind: z.enum(['option','text','cancel']), optionIndex: z.number().int().min(0).max(2).optional(), text: z.string().trim().min(1).max(8000).optional() }).strict().parse(await readJson(request, 10000));
        json(response, 200, await agent.call('runtime.command', { kind: 'runtime.answer_solution_selection', payload: { ...input, sessionId } })); return;
      }
      if (action === 'messages' && method === 'POST') {
        const input = messageSchema.parse(await readJson(request));
        if (!config.models.some(model => model.id === input.modelId)) throw new WebError(400, '模型未启用。');
        throttle(`message:${user.id}`, 100);
        const attachments = await Promise.all(input.attachments.map(id => agent.call('web.files', { action: 'describe', id }) as Promise<{ path: string; textPath?: string; mime: string; name: string; size: number }>));
        if (attachments.filter(item => item.mime.startsWith('image/')).length > 4 || attachments.reduce((sum, item) => sum + item.size, 0) > 24*1024*1024) throw new WebError(400, '每条消息最多 4 张图片，附件总计不超过 24 MB。');
        const { attachments: _ids, ...message } = input;
        const job = await agent.call('chat.send', { ...message, ...(attachments.length ? { files: attachments.filter(item => !item.mime.startsWith('image/')).map(item => item.textPath ?? item.path), images: attachments.filter(item => item.mime.startsWith('image/')).map(item => item.path), visionEnabled: true } : {}), sessionId, language: 'zh', permissionMode: 'task_free', planEnabled: false, sourceEnabled: false,
          userMessageMetadata: { userTimeZone: 'Asia/Shanghai', attachments }  });
        await store.touch(user.id, sessionId, input.text); json(response, 202, job); return;
      }
      if (action === 'jobs' && !jobId && method === 'GET') { json(response, 200, await jobs(agent, sessionId)); return; }
      if (action === 'jobs' && jobId && method === 'POST') {
        if (!(await jobs(agent, sessionId)).some(job => job.id === jobId)) throw new WebError(404, '任务不存在。');
        json(response, 200, await agent.call('chat.stop', { id: jobId })); return;
      }
      if (action === 'events' && method === 'GET') {
        const turnId = z.string().min(1).max(160).parse(url.searchParams.get('turnId'));
        if (!(await jobs(agent, sessionId)).some(job => job.turnId === turnId)) throw new WebError(404, '任务不存在。');
        const cursor = request.headers['last-event-id'] ?? url.searchParams.get('afterSequence');
        const afterSequence = cursor === null || cursor === undefined ? undefined : z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(cursor);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' }); response.flushHeaders();
        const validation = setInterval(() => { void store.authenticate(token).then(current => { if (!current) abort.abort(); }).catch(() => abort.abort()); }, 15_000);
        try {
          for await (const frame of agent.events({ sessionId, turnId, ...(afterSequence === undefined ? {} : { afterSequence }) }, abort.signal)) {
            if (frame.type === 'event' && !visibleEvents.has(frame.event.kind)) continue;
            const serialized = `${frame.type === 'event' ? `id: ${frame.event.sequence}\n` : ''}data: ${JSON.stringify(frame)}\n\n`;
            if (!response.write(serialized)) await once(response, 'drain', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
          }
          response.end();
        } finally { clearInterval(validation); }
        return;
      }
      throw new WebError(405, '请求方式不支持。');
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof WebError ? error.status : error instanceof z.ZodError ? 400 : 503;
      const message = error instanceof WebError ? error.message : error instanceof z.ZodError ? '输入内容不符合要求。' : '会话服务暂不可用，请稍后重试。';
      if (!(error instanceof WebError) && !(error instanceof z.ZodError)) console.error('Web request failed:', error instanceof Error ? error.name : 'UnknownError');
      json(response, status, { error: message }); request.resume();
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 4880, config.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Web listener did not bind.');
  return { port: address.port, close: async () => { for (const entry of active) entry.abort.abort(); agents.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function proxyImage(request: IncomingMessage, response: ServerResponse, url: URL, config: WebServerConfig, store: WebStore, signal: AbortSignal) {
  const match = url.pathname.match(/^\/internal\/image\/([^/]+)\/images\/generations$/);
  if (!match || request.method !== 'POST' || request.headers.origin !== undefined) throw new WebError(404, 'Not found.');
  const userId = decodeURIComponent(match[1]);
  if (!equalSecret(request.headers.authorization ?? '', `Bearer ${imageToken(config.modelSecret, userId)}`)) throw new WebError(401, 'Unauthorized.');
  if (!await store.imageAllowed(userId)) throw new WebError(403, 'Image plugin access is disabled.');
  const model = config.imageModel;
  if (!model) throw new WebError(503, 'Image service is not configured.');
  const destination = new URL(model.baseURL);
  if (destination.protocol !== 'https:' || destination.hostname !== 'ark.cn-beijing.volces.com' || destination.pathname.replace(/\/$/, '') !== '/api/v3' || destination.username || destination.password || destination.search || destination.hash) throw new Error('Invalid fixed image endpoint.');
  const body = z.object({ model: z.string().max(160), prompt: z.string().trim().min(1).max(12000), size: z.string().max(24), watermark: z.boolean(), response_format: z.literal('b64_json'), output_format: z.literal('png'), image: z.array(z.string().max(23_000_000)).max(4).optional() }).strict().parse(await readJson(request, 24*1024*1024));
  if (!['1K','2K'].includes(body.size)) {
    const parts = body.size.match(/^([1-9]\d{0,4})x([1-9]\d{0,4})$/), w = Number(parts?.[1]), h = Number(parts?.[2]);
    if (!parts || w*h < 921600 || w*h > 4624220 || w/h < 1/16 || w/h > 16) throw new WebError(400, 'Invalid image dimensions.');
  }
  for (const image of body.image ?? []) {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new WebError(400, 'Only personal image data is accepted.');
    await normalizeWebImage(Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'));
  }
  // Grant checks are live at dispatch, including turns that predate revocation.
  if (!await store.imageAllowed(userId)) throw new WebError(403, 'Image plugin access is disabled.');
  const upstream = await fetch(`${destination.href.replace(/\/$/, '')}/images/generations`, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${model.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: model.model }), signal: AbortSignal.any([signal, AbortSignal.timeout(305000)]) });
  if (!upstream.ok) { await upstream.body?.cancel(); json(response, upstream.status, { error: { code: `provider_http_${upstream.status}` } }); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  let size = 0;
  if (upstream.body) for await (const chunk of upstream.body) {
    size += chunk.byteLength; if (size > 32*1024*1024) throw new Error('Image response exceeds limit.');
    if (!response.write(chunk)) await once(response, 'drain', { signal });
  }
  response.end();
}

async function proxyModel(request: IncomingMessage, response: ServerResponse, url: URL, config: WebServerConfig, store: WebStore, signal: AbortSignal) {
  const match = url.pathname.match(/^\/internal\/model\/([^/]+)\/([^/]+)\/(responses(?:\/input_tokens)?|chat\/completions|messages(?:\/count_tokens)?)$/);
  if (!match || request.method !== 'POST' || request.headers.origin !== undefined) throw new WebError(404, 'Not found.');
  const [, encodedUser, encodedModel, endpoint] = match, userId = decodeURIComponent(encodedUser), modelId = decodeURIComponent(encodedModel);
  const expected = modelToken(config.modelSecret, userId);
  const authorization = request.headers.authorization ?? `Bearer ${request.headers['x-api-key'] ?? ''}`;
  if (!equalSecret(authorization, `Bearer ${expected}`)) throw new WebError(401, 'Unauthorized.');
  const user = await store.user(userId); if (!user?.is_active) throw new WebError(401, 'Account is inactive.');
  const model = config.models.find(item => item.id === modelId); if (!model) throw new WebError(400, 'Model is unavailable.');
  const body = await readJson(request, 16 * 1024 * 1024);
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool: any) => !['function', undefined].includes(tool.type) || !webToolAllowed(String(tool.function?.name ?? tool.name))))) throw new WebError(403, 'Tool outside the deployment allowlist.');
  body.model = model.model; if (!endpoint.startsWith('messages')) body.store = false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` };
  if (model.apiProtocol === 'anthropic_messages') { headers['x-api-key'] = model.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  const upstream = await fetch(`${model.baseURL.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!upstream.ok) {
    const raw = (await upstream.text()).split(model.apiKey).join('[redacted]');
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(raw.slice(0, 16000)); return;
  }
  response.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), response, { signal }); else response.end();
}

if (process.argv[1]?.endsWith('webServer.mjs')) {
  const config = JSON.parse(await readFile(process.env.CARDBUSH_WEB_CONFIG ?? '/run/cardbush/web.json', 'utf8')) as WebServerConfig & {
    databaseURL: string; brokerURL: string; brokerSecret: string; internalURL: string;
  };
  const store = new PostgresWebStore(config.databaseURL); await store.migrate();
  const agents = new BrokerWebAgents(config, userId => store.imageAllowed(userId));
  const listener = await serveWeb(config, store, agents);
  console.log(`CardBush web listening on ${listener.port}; restricted tools and isolated personal folders.`);
  let closing = false;
  const close = () => { if (closing) return; closing = true; void listener.close().finally(() => store.pool.end()); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
