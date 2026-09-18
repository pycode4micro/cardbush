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
  const assertExtension = (before, after) => {
    assert.deepEqual(after.tools, before.tools, 'worker launches preserve the source tool declarations and order');
    assert.deepEqual(after.input.slice(0, before.input.length), before.input, 'the full transmitted history remains a prefix');
    for (const key of ['temperature', 'top_p', 'max_output_tokens', 'reasoning']) assert.deepEqual(after[key], before[key]);
  };
  try {
    const binding = (await bind()).binding;
    const tools = (await command('runtime.get_tool_catalog')).filter(tool => ['checkpoint_context', 'read_file', 'schedule_task', 'scheduled_results', 'terminal_exec', 'update_task_plan', 'mcp_search', 'mcp_call'].includes(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(tools.length, 8);
    const generation = { temperature: 0, topP: 0.73, maxOutputTokens: 4096, reasoningEffort: 'high' };
    const result = await command('runtime.run_session_turn', { protocol: 'bush.session_turn_request.v1', requestId: 'human', sessionId: 'session', turnId: 'human', model: 'fixture', providerBinding: binding,
      tools, ...generation, prefixMessages: [{ role: 'system', content: '使用中文，按用户请求执行。' }], inputMessages: [{ messageId: 'human', message: { role: 'user', content: '建立会话。' } }],
      metadata: {}, sessionMetadata: { title: 'Fixture schedule' }, permissionMode: 'task_free' });
    assert.equal(result.payload.status, 'completed');
    const job = await automate({ action: 'create', definition: { name: '项目检查', prompt: '检查最新结果。', sessionId: 'session', timeZone: 'Asia/Shanghai', trigger: { kind: 'once', at: new Date(Date.now()+3600000).toISOString() } } });
    assert.equal((await automate({ action: 'list' })).sessions[0].title, 'Fixture schedule');
    // Restart the actual utility worker. Provider bindings are private and must be rehydrated.
    controller.stop(); await command('runtime.automation_start');
    await automate({ action: 'run', id: job.id });
    await until(async () => (await automate({ action: 'list' })).jobs[0].runs.at(-1)?.status === 'completed');
    assert.equal(requests.length, 2); assert.equal(modelReads, 1); assert.ok(notices >= 4);
    assert.deepEqual(requests[1].tools, requests[0].tools);
    for (const key of ['temperature', 'top_p', 'max_output_tokens', 'reasoning']) assert.deepEqual(requests[1][key], requests[0][key], `saved ${key} survives restart`);
    assert.ok(JSON.stringify(requests[1]).includes('检查最新结果。'));
    assert.ok(JSON.stringify(requests[1]).includes('使用中文，按用户请求执行。'));
    const history = await command('runtime.get_session', { sessionId: 'session' }); assert.equal(history.turns.length, 1, 'isolated runs do not append to the source');
    const executed = (await automate({ action: 'list' })).jobs[0].runs.at(-1);
    assert.notEqual(executed.sessionId, 'session');
    const executionHistory = await command('runtime.get_session', { sessionId: executed.sessionId });
    assert.equal(executionHistory.turns.length, 1); assert.equal(executionHistory.turns[0].turnId, executed.turnId);
    assert.equal(executionHistory.metadata.automationRunId, executed.id);
    assert.equal(executionHistory.metadata.hidden, true, 'temporary executions stay out of Recent');
    assert.equal(executionHistory.metadata.automationSourceSessionId, 'session');
    const activation = executionHistory.turns[0].messages.find(item => item.message.name === 'automation_context');
    assert.ok(activation, 'the trigger is part of committed turn input');
    assert.equal(activation.createdAt, executed.startedAt);
    assert.ok(activation.message.content.includes(executed.startedAt));
    assert.equal((await automate({ action: 'reminder' })).total, 1);
    const conversation = await automate({ action: 'conversation', id: job.id, runIds: [executed.id] });
    assert.equal(conversation.sourceSession.id, 'session'); assert.equal(conversation.executionSessionAvailable, true);
    assert.equal(conversation.model, 'fixture-config'); assert.equal(conversation.run.result, '已检查。');
    assert.equal((await automate({ action: 'reminder' })).total, 1, 'reading a result is not acknowledgment');
    // Binding refreshed by the restarted worker; retrieve its current reference.
    const currentBinding = (await bind()).binding;
    const followup = (id, sessionId = executed.sessionId) => command('runtime.run_session_turn', { protocol: 'bush.session_turn_request.v1', requestId: id, sessionId, turnId: id, model: 'fixture', providerBinding: currentBinding,
      tools, ...generation, prefixMessages: [{ role: 'system', content: '使用中文，按用户请求执行。' }], inputMessages: [{ messageId: id, message: { role: 'user', content: '继续解释结果。' } }], metadata: {}, permissionMode: 'task_free' });
    await followup('follow-up');
    assert.match(JSON.stringify(requests[2]), /automation_unread_reminder/);
    const followed = await command('runtime.get_session', { sessionId: executed.sessionId });
    assert.equal(followed.turns.length, 2); assert.equal(followed.turns[1].messages[0].message.content, '继续解释结果。');
    assert.equal(followed.turns[1].messages[0].metadata.automationReminder.total, 1);
    const reminder = followed.turns[1].messages.find(message => message.message.name === 'automation_unread_reminder');
    assert.equal(reminder.message.visibility, 'internal');
    assertExtension(requests[1], requests[2]);
    await automate({ action: 'mark_read', runIds: [executed.id] });
    await followup('after-read'); assertExtension(requests[2], requests[3]);
    const afterRead = await command('runtime.get_session', { sessionId: executed.sessionId });
    assert.deepEqual(afterRead.turns[1].messages.find(message => message.message.name === 'automation_unread_reminder'), reminder);
    const cleared = afterRead.turns[2].messages.find(message => message.message.name === 'automation_unread_reminder');
    assert.equal(JSON.parse(cleared.message.content.split('\n').at(-1)).total, 0);
    const stored = readFileSync(join(root, 'runtime', 'scheduler', 'automations.json'), 'utf8'); assert.doesNotMatch(stored, /FIXTURE_ONLY/);
    assert.doesNotMatch(JSON.stringify(await automate({ action: 'list' })), /prefixMessages|FIXTURE_ONLY/);
    removed = true; await automate({ action: 'run', id: job.id });
    await until(async () => (await automate({ action: 'list' })).jobs[0].runs.at(-1)?.status === 'failed');
    assert.equal(requests.length, 4); assert.equal((await automate({ action: 'list' })).jobs[0].state, 'paused');
    removed = false;
    const continued = await automate({ action: 'create', definition: { name: '继续原会话', prompt: '检查已有记录。', sessionId: 'session', executionMode: 'conversation', timeZone: 'Asia/Shanghai', trigger: { kind: 'event', event: 'PostToolUse', tool: 'fixture_uninvoked_event', cooldownSeconds: 60 } } });
    await automate({ action: 'run', id: continued.id });
    await until(async () => (await automate({ action: 'list' })).jobs.find(job => job.id === continued.id).runs.at(-1)?.status === 'completed');
    assert.equal(requests.length, 5); assertExtension(requests[0], requests[4]);
    await followup('source-followup', 'session'); assertExtension(requests[4], requests[5]);
    await automate({ action: 'run', id: continued.id });
    await until(async () => { const runs = (await automate({ action: 'list' })).jobs.find(job => job.id === continued.id).runs; return runs.length === 2 && runs.at(-1).status === 'completed'; });
    assert.equal(requests.length, 7); assertExtension(requests[5], requests[6]);
    const continuedHistory = await command('runtime.get_session', { sessionId: 'session' });
    assert.equal(continuedHistory.turns.flatMap(turn => turn.messages).filter(item => item.message.name === 'automation_context').length, 2);
    const independent = await automate({ action: 'create', definition: { name: '独立闹钟', prompt: '检查当前项目的导出结果。', sessionId: 'session', executionMode: 'conversation', timeZone: 'Asia/Shanghai', trigger: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString() } } });
    assert.equal(independent.executionMode, 'isolated');
    assert.equal((await command('runtime.delete_session', { sessionId: 'session' })).deleted, true);
    assert.equal((await automate({ action: 'list' })).jobs.find(job => job.id === independent.id).state, 'active');
    controller.stop(); await command('runtime.automation_start');
    await automate({ action: 'run', id: independent.id });
    await until(async () => (await automate({ action: 'list' })).jobs.find(job => job.id === independent.id).runs.at(-1)?.status === 'completed');
    const independentRun = (await automate({ action: 'list' })).jobs.find(job => job.id === independent.id).runs.at(-1);
    const detached = await automate({ action: 'conversation', id: independent.id, runIds: [independentRun.id] });
    assert.equal(detached.sourceSession, undefined); assert.equal(detached.executionSessionAvailable, true);
    assert.equal(detached.job.sessionId, 'session'); assert.equal(detached.run.result, '已检查。');
    assert.equal(await command('runtime.get_session', { sessionId: 'session' }), null, 'deleted source is not recreated');
    assert.equal(requests.length, 8); assert.deepEqual(requests[7].tools, requests[0].tools);
    for (const key of ['temperature', 'top_p', 'max_output_tokens', 'reasoning']) assert.deepEqual(requests[7][key], requests[0][key]);
    assert.doesNotMatch(JSON.stringify(requests[7].input), /建立会话|继续解释结果|检查已有记录/);
    const temporary = await command('runtime.get_session', { sessionId: independentRun.sessionId });
    assert.equal(temporary.metadata.hidden, true);
    await command('runtime.update_session_metadata', { sessionId: temporary.sessionId, expectedRevision: temporary.revision, metadata: { ...temporary.metadata, hidden: false } });
    assert.equal((await command('runtime.get_session', { sessionId: temporary.sessionId })).metadata.hidden, false, 'explicit full-conversation access promotes the existing run');
    console.log('Automation Electron integration passed: independent timer after source deletion and worker restart, hidden execution, source links, promotion, preserved tool order/generation parameters, immutable reminders, event continuations and removed-model failure.');
  } finally { controller.stop(); await new Promise(resolve=>server.close(resolve)); clearTimeout(deadline); }
}
