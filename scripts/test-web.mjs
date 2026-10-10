import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { hashWebPassword, verifyWebPassword } from '../dist-electron/webStore.mjs';
import { WebError, modelToken, tenantKey } from '../dist-electron/webCommon.mjs';
import { webToolAllowed, webToolDenial, WEB_BASE_TOOLS } from '../packages/bush-runtime/dist/webToolPolicy.js';
import { AgentWebFiles } from '../dist-electron/agentWebFiles.mjs';
import { DockerTenantBroker } from '../dist-electron/webTenantBroker.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, test, timeout = 20000) {
  const start = Date.now(); let value;
  while (Date.now() - start < timeout) { value = await read(); if (test(value)) return value; await pause(40); }
  assert.fail(`Timed out: ${JSON.stringify(value)}`);
}
class MemoryStore {
  accounts = ['alice', 'bob', 'admin'].map(name => ({ id: `usr_${name}`, username: name, display_name: name, role: name === 'admin' ? 'admin' : 'member', is_active: true, department_id: null }));
  tokens = new Map(); rows = new Map(); plugins = { installed: false, enabled: false, grants: [] };
  async plugin() { return this.plugins; }
  async imageAllowed(id) { return this.plugins.installed && this.plugins.enabled && this.plugins.grants.includes(id) && (await this.user(id))?.is_active; }
  async updatePlugin(actor,input) { if(actor.role !== 'admin') throw new WebError(403,'Forbidden'); const p=this.plugins; if(input.action==='install')p.installed=p.enabled=true; if(input.action==='disable')p.enabled=false; if(input.action==='enable')p.enabled=p.installed; if(input.action==='uninstall'){p.installed=p.enabled=false;p.grants=[];} return p; }
  async grantPlugin(actor,id,enabled) { if(actor.role !== 'admin') throw new WebError(403,'Forbidden'); this.plugins.grants=this.plugins.grants.filter(x=>x!==id); if(enabled)this.plugins.grants.push(id); return this.plugins; }
  async authenticate(token) { const user = this.accounts.find(user => user.id === this.tokens.get(token)); return user?.is_active ? user : null; }
  async login(input) { const user = this.accounts.find(user => user.username === input.username && user.is_active); if (!user || input.password !== 'fixture-password') throw new WebError(401, 'Invalid password'); const token = randomBytes(40).toString('base64url'); this.tokens.set(token, user.id); return { token, user }; }
  async register() { return { message: '等待管理员审批' }; }
  async logout(token) { this.tokens.delete(token); }
  async user(id) { return this.accounts.find(user => user.id === id) ?? null; }
  async departments() { return []; }
  async users() { return this.accounts; }
  async updateUser(actor, id, input) { if (actor.role !== 'admin') throw new WebError(403, 'Forbidden'); const user = await this.user(id); Object.assign(user, input); return user; }
  async list(userId) { return [...this.rows.values()].filter(row => row.userId === userId).map(row => row.value); }
  async conversation(userId, id) { const row = this.rows.get(id); if (!row || row.userId !== userId) throw new WebError(404, 'Not found'); return row.value; }
  async create(userId, id, title) { if (!this.rows.has(id)) this.rows.set(id, { userId, value: { id, title, pinned: false, archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }); return this.conversation(userId, id); }
  async update(userId, id, input) { const value = await this.conversation(userId, id); Object.assign(value, input); return value; }
  async remove(userId, id) { await this.conversation(userId, id); this.rows.delete(id); }
  async touch(userId, id, text) { const row = await this.conversation(userId, id); if (row.title === '新对话') row.title = text.slice(0, 40); }
}
async function fixture(t, malicious = false) {
  const base = resolve('tmp/web-tests'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'run-'));
  const calls = []; let web; const services = new Map();
  const marker = join(root, 'must-never-exist.txt');
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
    if (request.url.endsWith('/input_tokens')) { response.end(JSON.stringify({ input_tokens: 100 })); return; }
    calls.push(body); const n = calls.length;
    const item = malicious && n === 1 ? { id: 'bad-call', call_id: 'bad-call', type: 'function_call', name: malicious === 'solution' ? 'solution_selection' : malicious === 'read' ? 'read_file' : 'terminal_exec',
      arguments: JSON.stringify(malicious === 'solution' ? {prompt:'选择方案', options:['方案甲','方案乙']} : malicious === 'read' ? {path:join(root,'usr_alice','workspaces','uploads','native.txt')} : { command: `echo forbidden > "${marker}"`, cwd: root, shell: process.platform === 'win32' ? 'cmd' : 'posix' }), status: 'completed' }
      : { id: `msg-${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `reply-${n}`, annotations: [] }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const output = { id: `resp-${n}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response: output }); emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    await pause(120);
    if (response.destroyed) return;
    emit(item.type === 'function_call' ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments } : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: `reply-${n}` });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...output, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }); response.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const modelURL = `http://127.0.0.1:${model.address().port}/v1`;
  const pool = {
    async get(userId) {
      let service = services.get(userId);
      if (!service) {
        service = await AgentService.open({ dataRoot: join(root, userId), webRestricted: true, env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
        await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [{ id: 'fixture', provider: 'openai', model: 'fixture', apiKey: 'fixture-key', baseURL: modelURL }] } });
        await service.call('web.configure', { imageEnabled:false, gateway:'http://private.test/images', credential:'g'.repeat(64) });
        services.set(userId, service);
      }
      return { call: (...args) => service.call(...args), async *events(input, signal) { yield { type: 'ready' }; for await (const event of service.eventStream(input, signal)) yield { type: 'event', event }; yield { type: 'end' }; } };
    }, close() {},
  };
  const store = new MemoryStore(); const origin = 'http://web.test';
  web = await serveWeb({ origin, host: '127.0.0.1', port: 0, staticRoot: resolve('dist-web'), modelSecret: 'm'.repeat(64), defaultModelId: 'fixture', models: [{ id: 'fixture', name: 'Fixture', model: 'fixture', apiKey: 'fixture-key', baseURL: modelURL }] }, store, pool);
  const baseURL = `http://127.0.0.1:${web.port}`;
  t.after(async () => {
    await web.close(); for (const service of services.values()) await service.close();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  });
  async function login(username) {
    const response = await fetch(`${baseURL}/api/web/v1/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'fixture-password' }) });
    assert.equal(response.status, 200); const body = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { body, cookie, async request(path, method = 'GET', data, overrides = {}) {
      const response = await fetch(`${baseURL}${path.startsWith('/api/') || path.startsWith('/internal/') ? path : `/api/web/v1${path}`}`, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': body.csrf, ...(data ? { 'Content-Type': 'application/json' } : {}), ...overrides }, ...(data ? { body: JSON.stringify(data) } : {}) });
      return response;
    } };
  }
  return { root, marker, calls, pool, services, store, baseURL, origin, login };
}

test('passwords remain compatible with legacy Python scrypt hashes', async () => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const digest = scryptSync('original-password', salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  assert.equal(await verifyWebPassword('original-password', `scrypt$16384$8$1$${salt.toString('hex')}$${digest}`), true);
  const encoded = await hashWebPassword('new-password'); assert.equal(await verifyWebPassword('new-password', encoded), true);
  assert.equal(await verifyWebPassword('wrong-password', encoded), false);
  assert.equal(await verifyWebPassword('x', encoded.replace('16384', '1073741824')), false);
});

test('authentication, CSRF, origin and public API are restrictive', async t => {
  const f = await fixture(t), a = await f.login('alice');
  assert.equal((await fetch(`${f.baseURL}/api/web/v1/sessions`)).status, 401);
  assert.equal((await a.request('/sessions', 'POST', { requestId: randomUUID() }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await a.request('/sessions', 'POST', { requestId: randomUUID() }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await a.request('/api/agent/v1/call', 'POST', { operation: 'runtime.command' })).status, 404);
  assert.equal((await a.request('/admin/users')).status, 403);
  assert.equal(a.body.toolsEnabled, true); assert.equal(JSON.stringify(a.body).includes('fixture-key'), false);
  assert.equal((await a.request('/sessions', 'GET', undefined, { 'X-CardBush-User': 'usr_bob' })).status, 401);
  const headers = await a.request('/sessions');
  assert.match(headers.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
  assert.match(headers.headers.get('cache-control'), /no-store/);
  assert.equal(f.services.size, 0);
});

test('two accounts and even administrators cannot read, mutate, stop or stream another account session', async t => {
  const f = await fixture(t), a = await f.login('alice'), b = await f.login('bob'), admin = await f.login('admin');
  const createId = randomUUID(); const response = await a.request('/sessions', 'POST', { requestId: createId }); assert.equal(response.status, 201); const session = await response.json();
  const duplicate = await (await a.request('/sessions', 'POST', { requestId: createId })).json(); assert.equal(duplicate.id, session.id);
  const send = await a.request(`/sessions/${session.id}/messages`, 'POST', { requestId: randomUUID(), text: 'ALICE PRIVATE CONTEXT', modelId: 'fixture' }); assert.equal(send.status, 202); const job = await send.json();
  for (const other of [b, admin]) {
    assert.deepEqual(await (await other.request('/sessions')).json(), []);
    for (const [path, method, body] of [
      [`/sessions/${session.id}`, 'GET'], [`/sessions/${session.id}`, 'PATCH', { title: 'stolen' }], [`/sessions/${session.id}`, 'DELETE', {}],
      [`/sessions/${session.id}/jobs/${job.id}/stop`, 'POST', {}], [`/sessions/${session.id}/events?turnId=${job.turnId}`, 'GET'],
      [`/sessions/${session.id}/messages`, 'POST', { requestId: randomUUID(), text: 'steal', modelId: 'fixture' }],
    ]) assert.equal((await other.request(path, method, body)).status, 404, path);
  }
  assert.equal(f.services.size, 1, 'denials do not even open another runtime');
  const own = await (await b.request('/sessions', 'POST', { requestId: randomUUID() })).json();
  await b.request(`/sessions/${own.id}/messages`, 'POST', { requestId: randomUUID(), text: 'BOB PRIVATE CONTEXT', modelId: 'fixture' });
  await until(() => f.services.get('usr_bob').call('chat.jobs', {}), jobs => jobs.every(job => job.status === 'completed'));
  const bobCalls = f.calls.filter(call => JSON.stringify(call.input).includes('BOB PRIVATE CONTEXT')); assert.ok(bobCalls.length); assert.ok(bobCalls.every(call => !JSON.stringify(call.input).includes('ALICE PRIVATE CONTEXT')));
  assert.equal((await f.services.get('usr_bob').call('sessions.get', { sessionId: session.id })), null);
});

test('restricted tool ceiling survives a malicious model and all_free input', async t => {
  const f = await fixture(t, true); await f.pool.get('usr_alice'); const service = f.services.get('usr_alice');
  assert.equal(service.info().capabilities.webRestricted, true);
  for (const [operation, input] of [['mcp.configure', {}], ['plugins.install', { path: f.root }], ['runtime.command', { kind: 'runtime.terminal_exec' }], ['delegation.submit', {}], ['configuration.sync', {}]]) await assert.rejects(service.call(operation, input), /unavailable/);
  await service.call('sessions.create', { sessionId: 'text-only' });
  await assert.rejects(service.call('chat.send', { requestId: 'goal', sessionId: 'text-only', text: 'goal', modelId: 'fixture', goalObjective: 'goal' }), /unavailable/);
  await service.call('chat.send', { requestId: 'host-policy', sessionId: 'text-only', text: 'Write a file using terminal.', modelId: 'fixture', permissionMode: 'all_free' });
  const jobs = await until(() => service.call('chat.jobs', {}), jobs => jobs.every(job => !['running', 'queued'].includes(job.status)));
  assert.equal(jobs[0].status, 'completed', JSON.stringify(jobs));
  assert.ok(f.calls.length >= 2); assert.ok(f.calls.every(call => call.tools.every(tool => webToolAllowed(tool.name ?? tool.function?.name))));
  for (const name of WEB_BASE_TOOLS) assert.ok(f.calls[0].tools.some(tool => (tool.name ?? tool.function?.name) === name), name);
  assert.equal(await readFile(f.marker).then(() => true, () => false), false);
  const events = await service.runtime.transport.sendCommand({ kind: 'runtime.list_turn_events', payload: { sessionId: 'text-only', turnId: jobs[0].turnId } });
  assert.match(JSON.stringify(events), /web_tool_denied|tool_not_exposed/);
});

test('message retries deduplicate, events replay, and history survives runtime reopening', async t => {
  const f = await fixture(t), a = await f.login('alice'); const session = await (await a.request('/sessions', 'POST', { requestId: randomUUID() })).json();
  const input = { requestId: randomUUID(), text: 'Remember this conversation.', modelId: 'fixture' };
  const first = await (await a.request(`/sessions/${session.id}/messages`, 'POST', input)).json();
  const again = await (await a.request(`/sessions/${session.id}/messages`, 'POST', input)).json(); assert.equal(first.id, again.id);
  assert.equal((await a.request(`/sessions/${session.id}/messages`, 'POST', { ...input, tools: ['terminal_exec'] })).status, 400);
  await until(() => f.services.get('usr_alice').call('chat.jobs', {}), jobs => jobs.every(job => job.status === 'completed'));
  const stream = await a.request(`/sessions/${session.id}/events?turnId=${first.turnId}`); const frames = (await stream.text()).split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  const events = frames.filter(frame => frame.type === 'event').map(frame => frame.event); assert.ok(events.some(event => event.kind === 'assistant_segment_delta')); assert.equal(frames.at(-1).type, 'end');
  const cursor = events[0].sequence;
  const replay = await (await a.request(`/sessions/${session.id}/events?turnId=${first.turnId}&afterSequence=${cursor}`)).text();
  assert.ok(replay.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).filter(frame => frame.event).every(frame => frame.event.sequence > cursor));
  const old = f.services.get('usr_alice'); await old.close(); f.services.delete('usr_alice'); await f.pool.get('usr_alice');
  const restored = await f.services.get('usr_alice').call('sessions.get', { sessionId: session.id }); assert.equal(restored.turns.length, 1); assert.match(JSON.stringify(restored), /Remember this conversation/);
  await a.request('/auth/logout', 'POST', {}); assert.equal((await a.request('/sessions')).status, 401); assert.equal((await a.request(`/sessions/${session.id}/events?turnId=${first.turnId}`)).status, 401);
});

test('model proxy binds credentials to an active account and rejects tools', async t => {
  const f = await fixture(t);
  const path = `${f.baseURL}/internal/model/usr_alice/fixture/responses`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${modelToken('m'.repeat(64), 'usr_alice')}` };
  assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ tools: [{ type: 'web_search' }] }) })).status, 403);
  assert.equal((await fetch(path.replace('usr_alice', 'usr_bob'), { method: 'POST', headers, body: '{}' })).status, 401);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Origin: f.origin }, body: '{}' })).status, 404);
  f.store.accounts[0].is_active = false;
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('broker creates only a private, bounded, unprivileged tool-disabled container', async () => {
  const broker = new DockerTenantBroker({ secret: 's'.repeat(64), image: 'fixture:tag', network: 'private-test', prefix: 'cbtest' });
  const calls = [];
  broker.docker = async (method, path, body) => { calls.push({ method, path, body }); return path.startsWith('/containers/json') ? [] : path.startsWith('/containers/create') ? { Id: 'container-a' } : undefined; };
  await assert.rejects(broker.ensure('../another-user'), /identity/);
  const key = tenantKey('usr_alice'); const result = await broker.ensure(key); const config = calls.find(call => call.body).body;
  assert.equal(config.User, '1100:1100'); assert.ok(config.Cmd.includes('--web-restricted')); assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.equal(config.HostConfig.NetworkMode, 'private-test'); assert.equal(config.HostConfig.Mounts.length, 1); assert.equal(config.HostConfig.Mounts[0].Type, 'volume');
  assert.equal(config.HostConfig.PortBindings, undefined); assert.equal(config.Labels['cardbush.web.tenant'], key); assert.ok(result.token.length >= 32);
});


test('personal file reads reject traversal, secrets, symlinks and unexpected tools even with all_free', async t => {
  const f=await fixture(t), agent=await f.pool.get('usr_alice'), service=f.services.get('usr_alice');
  const personal=join(service.root,'workspaces'), plugins=join(service.root,'plugins'); await mkdir(personal,{recursive:true});await mkdir(plugins,{recursive:true});
  const mine=join(personal,'mine.txt'), secret=join(service.root,'access-token');await writeFile(mine,'private');await writeFile(secret,'SECRET');
  const request={permissionMode:'all_free',metadata:{toolExecutionPolicy:'web_restricted',workspaceDir:personal,webReadRoots:[personal,plugins]}};
  assert.equal(await webToolDenial(request,'read_file',{path:mine}),undefined);
  for(const path of [secret,'../access-token','/etc/passwd','https://example.test/x','data:image/png;base64,a','\\\\another-user\\file']) assert.ok(await webToolDenial(request,'read_file',{path}),path);
  const link=join(personal,'escape');
  try {await symlink(service.root,link,'junction');assert.ok(await webToolDenial(request,'read_file',{path:join(link,'access-token')}));} finally {await rm(link,{force:true}).catch(()=>{});}
  assert.ok(await webToolDenial(request,'terminal_exec',{}));
  assert.ok(await webToolDenial(request,'inject_image_input',{url:'http://internal/config'}));
  assert.ok(await webToolDenial(request,'read_file',{path:mine,environment:'remote'}));
  await assert.rejects(agent.call('web.files',{action:'read',path:secret}),/denied/);
});

test('uploads are resumable, validated and private; videos and forged attachments are rejected', async t=>{
  const f=await fixture(t),a=await f.login('alice'),b=await f.login('bob'); const uploadId=randomUUID();
  const data={uploadId,name:'notes.txt',offset:0,size:12,content:Buffer.from('hello ').toString('base64'),done:false};
  assert.equal((await a.request('/files','POST',data)).status,200);
  assert.equal((await a.request('/files','POST',data)).status,200);
  const finished=await (await a.request('/files','POST',{...data,offset:6,content:Buffer.from('world!').toString('base64'),done:true})).json();assert.ok(finished.attachment,JSON.stringify(finished));
  const path=finished.attachment.path;
  const ownSession=await(await a.request('/sessions','POST',{requestId:randomUUID()})).json();
  const sent=await a.request(`/sessions/${ownSession.id}/messages`,'POST',{requestId:randomUUID(),text:'Read this attachment',modelId:'fixture',attachments:[uploadId]});
  assert.equal(sent.status,202); const attachmentJob=await sent.json();
  assert.equal(attachmentJob.attachments[0].path,path);
  const ownJobs=await(await a.request(`/sessions/${ownSession.id}/jobs`)).json();
  assert.equal(ownJobs.find(job=>job.id===attachmentJob.id).attachments[0].path,path);
  assert.equal(await (await a.request('/files/view?path='+encodeURIComponent(path))).text(),'hello world!');
  assert.equal((await b.request('/files/view?path='+encodeURIComponent(path))).status,404);
  for(const name of ['video.mp4','video.png','video.txt']) {
    const bytes=Buffer.from('0000ftypmp42VIDEO');
    assert.equal((await a.request('/files','POST',{uploadId:randomUUID(),name,offset:0,size:bytes.length,content:bytes.toString('base64'),done:true})).status,400,name);
  }
  const session=await(await b.request('/sessions','POST',{requestId:randomUUID()})).json();
  assert.equal((await b.request(`/sessions/${session.id}/messages`,'POST',{requestId:randomUUID(),text:'steal',modelId:'fixture',attachments:[uploadId]})).status,503);
});

test('only admins install plugins and grants are checked again after revocation',async t=>{
  const f=await fixture(t),a=await f.login('alice'),admin=await f.login('admin');
  assert.equal((await a.request('/admin/plugins','POST',{action:'install'})).status,403);
  assert.equal((await admin.request('/admin/plugins','POST',{action:'install'})).status,200);
  assert.deepEqual(await(await a.request('/plugins')).json(),{imageEnabled:false});
  await admin.request('/admin/plugins/volcengine_images/users/usr_alice','PUT',{enabled:true});
  assert.deepEqual(await(await a.request('/plugins')).json(),{imageEnabled:true});
  await admin.request('/admin/plugins/volcengine_images/users/usr_alice','PUT',{enabled:false});
  assert.deepEqual(await(await a.request('/plugins')).json(),{imageEnabled:false});
  const {imageToken}=await import('../dist-electron/webCommon.mjs');
  assert.equal((await fetch(f.baseURL+'/internal/image/usr_alice/images/generations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+imageToken('m'.repeat(64),'usr_alice')},body:'{}'})).status,403);
});


test('native solution choices survive reconnect and only the owning account can answer',async t=>{
  const f=await fixture(t,'solution'),a=await f.login('alice'),b=await f.login('bob');
  const session=await(await a.request('/sessions','POST',{requestId:randomUUID()})).json();
  const start=Date.now();const job=await(await a.request(`/sessions/${session.id}/messages`,'POST',{requestId:randomUUID(),text:'Give me choices',modelId:'fixture'})).json();assert.ok(Date.now()-start<2000);
  const state=await until(async()=>await(await a.request(`/sessions/${session.id}`)).json(),value=>value.solutions?.length===1);
  const choice=state.solutions[0];assert.equal(choice.options.length,2);
  const answer={selectionId:choice.selectionId,turnId:choice.turnId,kind:'option',optionIndex:1};
  assert.equal((await b.request(`/sessions/${session.id}/solutions`,'POST',answer)).status,404);
  assert.equal((await a.request(`/sessions/${session.id}/solutions`,'POST',answer)).status,200);
  await until(()=>f.services.get('usr_alice').call('chat.jobs',{}),jobs=>jobs.every(job=>job.status==='completed'));
  const stream=await(await a.request(`/sessions/${session.id}/events?turnId=${job.turnId}`)).text();assert.match(stream,/solution_selection_requested/);
});

test('native Office inspection gives the agent a bounded readable attachment',async t=>{
  const {default:JSZip}=await import('jszip');const root=await mkdtemp(join(resolve('tmp/web-tests'),'doc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const zip=new JSZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Private document fact 357</w:t></w:r></w:p></w:body></w:document>');
  const bytes=await zip.generateAsync({type:'nodebuffer'}),files=new AgentWebFiles(root);
  const result=await files.call({action:'upload',uploadId:randomUUID(),name:'sample.docx',size:bytes.length,offset:0,content:bytes.toString('base64'),done:true});
  assert.ok(result.attachment.textPath);assert.match(await readFile(result.attachment.textPath,'utf8'),/Private document fact 357/);
});


test('native read admission accepts personal uploads outside the conversation workspace in task_free mode',async t=>{
 const f=await fixture(t,'read'),a=await f.login('alice');
 const session=await(await a.request('/sessions','POST',{requestId:randomUUID()})).json();
 const path=join(f.root,'usr_alice','workspaces','uploads');await mkdir(path,{recursive:true});await writeFile(join(path,'native.txt'),'PERSONAL_NATIVE_READ_724');
 const job=await(await a.request(`/sessions/${session.id}/messages`,'POST',{requestId:randomUUID(),text:'Read my uploaded text',modelId:'fixture'})).json();
 await until(()=>f.services.get('usr_alice').call('chat.jobs',{}),jobs=>jobs.every(job=>job.status==='completed'));
 assert.ok(f.calls.some(call=>JSON.stringify(call.input).includes('PERSONAL_NATIVE_READ_724')));
 const events=await f.services.get('usr_alice').runtime.transport.sendCommand({kind:'runtime.list_turn_events',payload:{sessionId:session.id,turnId:job.turnId}});
 assert.ok(!JSON.stringify(events).includes('permission_requested'));
 const state=await(await a.request(`/sessions/${session.id}`)).json();
 assert.equal(state.toolExecutions.length,1);
 assert.equal(state.toolExecutions[0].outcome,'returned');
 assert.equal(state.toolExecutions[0].result,undefined,'Summary must not eagerly include private file contents');
 const endpoint=`/sessions/${session.id}/tools?turnId=${encodeURIComponent(job.turnId)}`;
 const detail=await(await a.request(endpoint)).json();
 assert.equal(detail.length,1);assert.match(JSON.stringify(detail),/PERSONAL_NATIVE_READ_724/);
 const bob=await f.login('bob'),admin=await f.login('admin');
 assert.equal((await bob.request(endpoint)).status,404);
 assert.equal((await admin.request(endpoint)).status,404,'Admin does not own another user conversation');
 assert.equal((await a.request(`/sessions/${session.id}/tools?turnId=unrelated-turn`)).status,404);
 assert.equal((await a.request(endpoint,'POST',{})).status,405);
 assert.equal((await fetch(f.baseURL+'/api/web/v1'+endpoint)).status,401);
});
