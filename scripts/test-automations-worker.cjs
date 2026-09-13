const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const electron = require('electron');
const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'cardbush-automations-worker-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(electron, [__filename, root], { env, stdio: 'inherit', windowsHide: true, timeout: 35000 });
  assert.ok(root.startsWith(parent + sep + 'cardbush-automations-worker-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}
const { app } = electron, root = resolve(process.argv[2]);
mkdirSync(join(root, 'profile')); app.setPath('userData', join(root, 'profile'));
const deadline = setTimeout(() => { console.error('Automation worker timed out'); app.exit(1); }, 30000);
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
async function run() {
  await app.whenReady();
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.headers.authorization, 'Bearer FIXTURE_ONLY');
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const result = { id: 'resp_'+randomUUID(), object: 'response', created_at: Math.floor(Date.now()/1000), model: 'fixture', status: 'completed',
        output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '已检查。', annotations: [] }] }], error: null, incomplete_details: null, usage: null, store: false };
      for (const event of [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_text.delta', delta: '已检查。', item_id: 'msg_fixture', output_index: 0, content_index: 0 },
        { type: 'response.completed', response: result }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch (error) { console.error(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
  writeFileSync(join(root, 'apps.json'), JSON.stringify({ serviceEnabled: false, revision: 1, plugins: [] }));
  let notices = 0, modelReads = 0, removed = false;
  const controller = new RuntimeUtilityProcessController({ modulePath: resolve('dist-electron/runtimeHostWorker.mjs'),
    env: { ...env, CARDBUSH_RUNTIME_STATE_ROOT: join(root, 'runtime'), CARDBUSH_APPS_CONFIG_PATH: join(root, 'apps.json'), CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]' },
    onMcpHostRequest: async (operation, payload) => {
      if (operation === 'automation.changed') { notices++; return {}; }
      assert.equal(operation, 'automation.prepare-model'); assert.equal(payload.modelId, 'fixture-config'); modelReads++;
      if (removed) throw Error('The automation model was removed.');
      return { model: 'fixture', binding: (await bind()).binding };
    }, onStderr: text => process.stderr.write(text),
  });
  const command = async (kind, payload = {}) => {
    const result = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  };
  const bind = () => command('runtime.upsert_provider_binding', { protocol: 'bush.provider_binding_config.v1', bindingId: 'fixture-config', adapter: 'openai_responses', apiKey: 'FIXTURE_ONLY', baseURL: `http://127.0.0.1:${server.address().port}/v1` });
  const automate = value => command('runtime.automation', value);
  const until = async check => { const end=Date.now()+6000; while (!await check()) { if(Date.now()>end)throw Error('Condition timed out'); await new Promise(resolve=>setTimeout(resolve,25)); } };
  try {
    const binding = (await bind()).binding;
    const result = await command('runtime.run_session_turn', { protocol: 'bush.session_turn_request.v1', requestId: 'human', sessionId: 'session', turnId: 'human', model: 'fixture', providerBinding: binding,
      tools: [], prefixMessages: [{ role: 'system', content: '使用中文，按用户请求执行。' }], inputMessages: [{ messageId: 'human', message: { role: 'user', content: '建立会话。' } }],
      metadata: {}, sessionMetadata: { title: 'Fixture schedule' }, permissionMode: 'task_free' });
    assert.equal(result.payload.status, 'completed');
    const job = await automate({ action: 'create', definition: { name: '项目检查', prompt: '检查最新结果。', sessionId: 'session', timeZone: 'Asia/Shanghai', trigger: { kind: 'once', at: new Date(Date.now()+3600000).toISOString() } } });
    assert.equal((await automate({ action: 'list' })).sessions[0].title, 'Fixture schedule');
    // Restart the actual utility worker. Provider bindings are private and must be rehydrated.
    controller.stop(); await command('runtime.automation_start');
    await automate({ action: 'run', id: job.id });
    await until(async () => (await automate({ action: 'list' })).jobs[0].runs.at(-1)?.status === 'completed');
    assert.equal(requests.length, 2); assert.equal(modelReads, 1); assert.ok(notices >= 4);
    assert.ok(JSON.stringify(requests[1]).includes('检查最新结果。'));
    assert.ok(JSON.stringify(requests[1]).includes('使用中文，按用户请求执行。'));
    const history = await command('runtime.get_session', { sessionId: 'session' }); assert.equal(history.turns.length, 1, 'isolated runs do not append to the source');
    const executed = (await automate({ action: 'list' })).jobs[0].runs.at(-1);
    assert.notEqual(executed.sessionId, 'session');
    const executionHistory = await command('runtime.get_session', { sessionId: executed.sessionId });
    assert.equal(executionHistory.turns.length, 1); assert.equal(executionHistory.turns[0].turnId, executed.turnId);
    assert.equal(executionHistory.metadata.automationRunId, executed.id);
    assert.equal((await automate({ action: 'reminder' })).total, 1);
    const conversation = await automate({ action: 'conversation', id: job.id, runIds: [executed.id] });
    assert.equal(conversation.model, 'fixture-config'); assert.equal(conversation.run.result, '已检查。');
    assert.equal((await automate({ action: 'reminder' })).total, 1, 'reading a result is not acknowledgment');
    // Binding refreshed by the restarted worker; retrieve its current reference.
    const currentBinding = (await bind()).binding;
    const followup = id => command('runtime.run_session_turn', { protocol: 'bush.session_turn_request.v1', requestId: id, sessionId: executed.sessionId, turnId: id, model: 'fixture', providerBinding: currentBinding,
      tools: [], prefixMessages: [{ role: 'system', content: '使用中文，按用户请求执行。' }], inputMessages: [{ messageId: id, message: { role: 'user', content: '继续解释结果。' } }], metadata: {}, permissionMode: 'task_free' });
    await followup('follow-up');
    assert.match(JSON.stringify(requests[2]), /automation_unread_reminder/);
    const followed = await command('runtime.get_session', { sessionId: executed.sessionId });
    assert.equal(followed.turns.length, 2); assert.equal(followed.turns[1].messages[0].message.content, '继续解释结果。');
    assert.equal(followed.turns[1].messages[0].metadata.automationReminder.total, 1);
    assert.ok(!followed.turns.flatMap(turn => turn.messages).some(message => message.message.name === 'automation_unread_reminder'), 'reminders do not become stale history');
    await automate({ action: 'mark_read', runIds: [executed.id] });
    await followup('after-read'); assert.doesNotMatch(JSON.stringify(requests[3]), /automation_unread_reminder/);
    const stored = readFileSync(join(root, 'runtime', 'scheduler', 'automations.json'), 'utf8'); assert.doesNotMatch(stored, /FIXTURE_ONLY/);
    assert.doesNotMatch(JSON.stringify(await automate({ action: 'list' })), /prefixMessages|FIXTURE_ONLY/);
    removed = true; await automate({ action: 'run', id: job.id });
    await until(async () => (await automate({ action: 'list' })).jobs[0].runs.at(-1)?.status === 'failed');
    assert.equal(requests.length, 4); assert.equal((await automate({ action: 'list' })).jobs[0].state, 'paused');
    console.log('Automation Electron integration passed: real provider stream, durable conversation, worker restart, private binding refresh, notifications and removed-model failure.');
  } finally { controller.stop(); await new Promise(resolve=>server.close(resolve)); clearTimeout(deadline); }
}
