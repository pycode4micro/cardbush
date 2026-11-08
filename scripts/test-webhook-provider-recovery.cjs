// Real Utility Process, Product model store and Assistant journal; only the remote model is a fixture.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { createServer } = require('node:http'), electron = require('electron');
if (typeof electron === 'string') {
  const parent = path.resolve(require('node:os').tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cardbush-webhook-model-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename, root], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('cardbush-webhook-model-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exit(result.status ?? 1);
}
const { app } = electron, root = path.resolve(process.argv[2]);
fs.mkdirSync(path.join(root, 'profile')); app.setPath('userData', path.join(root, 'profile'));
const deadline = setTimeout(() => { console.error('Webhook model recovery timed out'); app.exit(1); }, 55000);
run().then(() => { clearTimeout(deadline); app.exit(0); }, error => { console.error(error); app.exit(1); });
async function run() {
  await app.whenReady();
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { ElectronProductHostController } = await import('../dist-electron/productHostController.mjs');
  const { prepareWebhookParentModels, runContextWebhook } = await import('../dist-electron/contextWebhookRuntime.mjs');
  const { ContextWebhookHost } = await import('../dist-electron/contextWebhookHost.mjs');
  const { ProductModelConfigStore } = await import('@cardbush/product-host');
  const { assistantProfileSchema } = await import('@cardbush/bush-protocol');
  const requests = [], server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    requests.push({ body, authorization: req.headers.authorization });
    const response = { id: 'resp_' + randomUUID(), object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed',
      output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Recovered reply.', annotations: [] }] }],
      error: null, incomplete_details: null, usage: null, store: false };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_text.delta', delta: 'Recovered reply.', item_id: 'msg_fixture', output_index: 0, content_index: 0 },
      { type: 'response.completed', response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARDBUSH_')));
  fs.writeFileSync(path.join(root, 'apps.json'), '{"serviceEnabled":false,"revision":1,"plugins":[]}');
  const controller = new RuntimeUtilityProcessController({ modulePath: path.resolve('dist-electron/runtimeHostWorker.mjs'),
    env: { ...env, CARDBUSH_RUNTIME_STATE_ROOT: path.join(root, 'runtime'), CARDBUSH_APPS_CONFIG_PATH: path.join(root, 'apps.json'),
      CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]' }, onStderr: text => process.stderr.write(text) });
  const product = new ElectronProductHostController({ dataRoot: path.join(root, 'product'), runtimeStateRoot: path.join(root, 'runtime'),
    bundledSkillRoot: path.join(root, 'skills'), userSkillRoot: path.join(root, 'user-skills'), bundledPluginRoot: path.join(root, 'plugins'),
    userPluginRoot: path.join(root, 'user-plugins'), runtimeBridge: controller });
  const store = new ProductModelConfigStore(path.join(root, 'product/config/models.json'));
  const model = (id, apiKey = 'fixture-first', name = 'fixture') => ({ id, provider: 'fixture', model: name, apiKey,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiProtocol: 'openai_responses' });
  let prepared = 0, gateway;
  const bridge = { async command(kind, payload = {}) {
    const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
  }, prepareParent: (parent, signal) => prepareWebhookParentModels(parent, id => { prepared++; return product.resolveWebhookModel(id, 'zh'); }, signal) };
  const signal = new AbortController().signal, sessionId = 'personal-assistant';
  const until = async check => { const until = Date.now() + 10000; while (!await check()) {
    if (Date.now() > until) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    await store.write({ defaultModelId: 'primary', models: [model('primary'), model('child')] });
    const first = await product.resolveWebhookModel('primary'), child = await product.resolveWebhookModel('child');
    await bridge.command('runtime.create_session', { sessionId });
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'bound', turnId: 'bound', sessionId, model: first.model,
      providerBinding: first.binding, tools: [], prefixMessages: [], inputMessages: [{ messageId: 'bound', message: { role: 'user', content: 'bound' } }],
      metadata: { uiLanguage: 'zh', childAgentPolicy: { model: { mode: 'fixed', modelId: 'child', model: child.model, providerBinding: child.binding } } }, permissionMode: 'task_free' };
    const binding = { kind: 'assistant', sessionId, title: 'Assistant', parent, generation: 0, profile: assistantProfileSchema.parse({}) };
    const message = { messageId: 'in-1', senderId: 'owner', conversationId: 'wechat-owner', text: 'Please reply.' };
    controller.stop();
    const broken = await runContextWebhook({ command: bridge.command }, binding, message, 'first', false, signal, 'webhook:first');
    assert.equal(broken.status, 'failed'); assert.equal(requests.length, 0);
    const read = () => bridge.command('runtime.assistant_conversation', { action: 'read', sessionId });
    assert.match((await read()).error, /^Provider binding .+ is unavailable\.$/);
    // The user's retry refreshes the provider, retains input identity and does not duplicate the message.
    const retryParent = await bridge.prepareParent(parent, signal);
    await bridge.command('runtime.assistant_conversation', { action: 'retry', sessionId, generation: 0, profile: binding.profile, parent: retryParent });
    await until(async () => !(await read()).busy);
    assert.equal((await read()).error, ''); assert.equal((await read()).entries.filter(e => e.role === 'user' && e.source === 'text').length, 1);
    assert.equal(requests.length, 1); assert.ok(requests[0].body.input.some(item => item.content === message.text));
    assert.equal((await read()).entries.find(entry => entry.id === 'webhook-input-first').botSourceRef, 'webhook:first');
    // Saved references are now stale in both lifetime and revision; the next incoming message still works.
    await store.write({ defaultModelId: 'primary', models: [model('primary', 'fixture-second', 'fixture-new'), model('child', 'fixture-child-new')] });
    controller.stop();
    const resumed = await runContextWebhook(bridge, binding, { ...message, messageId: 'in-2' }, 'second', false, signal, 'webhook:second');
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.reply, 'Recovered reply.');
    assert.equal(requests.at(-1).authorization, 'Bearer fixture-second'); assert.equal(requests.at(-1).body.model, 'fixture-new');
    const refreshed = await bridge.prepareParent(parent, signal);
    assert.notDeepEqual(refreshed.providerBinding, parent.providerBinding);
    assert.notDeepEqual(refreshed.metadata.childAgentPolicy.model.providerBinding, parent.metadata.childAgentPolicy.model.providerBinding);
    assert.equal(refreshed.permissionMode, parent.permissionMode); assert.deepEqual(binding.parent, parent);
    const before = prepared;
    assert.equal((await runContextWebhook(bridge, binding, message, 'second', true, signal)).status, 'completed');
    assert.equal(prepared, before, 'recovery only reads the existing result without resolving or replaying a model request');
    await bridge.command('runtime.create_session', { sessionId: 'conversation' }); controller.stop();
    const conversation = { kind: 'conversation', sessionId: 'conversation', title: 'Conversation', parent: { ...parent, sessionId: 'conversation' } };
    await assert.rejects(runContextWebhook(bridge, conversation, message, 'conversation', false, signal),/assistant_only/);
    // The actual HTTP host must also refresh Assistant context independently of saved model bindings.
    const secrets = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    let connection = (await gateway.command({ action: 'save', binding, config: { name: 'Fixture bridge', enabled: true,
      url: '', headers: {}, parameters: {}, body: {}, incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } } })).connections[0];
    const send = id => fetch(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, messageId: id, text: id }) });
    const receipt = async id => (await fetch(connection.endpoint + '/' + id, { headers: { Authorization: `Bearer ${connection.token}` } })).json();
    const contextCount = requests.length;
    await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId });
    assert.equal((await send('http-after-reset')).status, 202);
    await until(async () => (await receipt('http-after-reset')).status === 'completed');
    assert.deepEqual((await read()).entries.filter(e => e.role === 'user').map(e => e.content), ['http-after-reset']);
    await gateway.close(); controller.stop();
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    connection = (await gateway.command({ action: 'read', sessionId })).connections[0];
    assert.equal((await (await send('http-after-reset')).json()).status, 'completed');
    assert.equal((await send('http-after-restart')).status, 202);
    await until(async () => (await receipt('http-after-restart')).status === 'completed');
    assert.equal(requests.length, contextCount + 2, 'new contexts refresh both generation and model registration without replay');
    assert.equal(requests.at(-1).authorization, 'Bearer fixture-second');
    await gateway.close(); gateway = undefined;
    await store.write({ defaultModelId: 'child', models: [model('child')] });
    const count = requests.length;
    await assert.rejects(runContextWebhook(bridge, binding, message, 'removed', false, signal), /此连接使用的模型已被移除/);
    assert.equal(requests.length, count, 'a removed bound model must never silently fall back to the default');
    await assert.rejects(prepareWebhookParentModels(parent, () => assert.fail('aborted preparation must not resolve models'), AbortSignal.abort()), { name: 'AbortError' });
    console.log('PASS: stale models, Assistant reset, HTTP host/worker restart, retries and new messages recover without replay; removed models fail closed.');
  } finally { await gateway?.close(); await product.stopMaintenance(); controller.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
