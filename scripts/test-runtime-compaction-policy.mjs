import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SessionStore, FileSessionEventPersistence } from '../packages/bush-runtime/dist/index.js';
import { AgentRuntimeHost } from '../dist-electron/agentRuntimeHost.mjs';

// Use the production worker, not an InMemoryRuntimeHost with its default options:
// a stale worker override previously disabled recorded handoffs in every product.
for (const mode of ['cli', 'service', 'desktop']) {
  test(`${mode} worker reuses recorded tool facts without prepared summaries, including after restart`, { timeout: 30000 }, async () => {
    const base = resolve('tmp/runtime-compaction-policy');
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'case-'));
    const sessionId = 'recorded-policy', now = '2026-10-29T00:00:00.000Z';
    const persistence = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    const store = new SessionStore({ persistence });
    const original = [];
    for (let index = 0; index < 2; index++) {
      const turnId = `old-${index}`, callId = `read-${index}`;
      const messages = [
        { role: 'user', content: `Inspect report ${index}. Do not publish it.` },
        { role: 'assistant', content: 'Reading the report.', toolCalls: [{ id: callId, name: 'read_file',
          argumentsText: JSON.stringify({ path: `report-${index}.txt`, reason: `Inspect report ${index}` }) }] },
        { role: 'tool', toolCallId: callId, content: JSON.stringify({ status: 'ok', report_id: `R-${index}`,
          published: false, content: 'unchanged report line\n'.repeat(3000) }) },
        { role: 'assistant', content: `Report R-${index} was inspected; publication is still pending.`, toolCalls: [] },
      ];
      const turn = { turnId, turnSequence: index + 1, createdAt: now, completedAt: now,
        status: 'completed', reason: 'model_response_completed', usage: {},
        messages: messages.map((message, messageIndex) => ({ messageId: `${turnId}-${messageIndex}`,
          turnId, turnSequence: index + 1, messageIndex, createdAt: now, message })) };
      store.commitTurn(sessionId, turn); original.push(turn.messages);
    }
    persistence.close();
    const requests = [];
    let runtime;
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      // Fail immediately if the worker asks the model to redo completed history.
      if (JSON.stringify(body.messages).includes('context_pressure')) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Unexpected model compaction', type: 'invalid_request_error' } })); return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'fixture', model: body.model,
        choices: [{ index: 0, delta: { content: 'The reports remain unpublished.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CARDBUSH_|NODE_OPTIONS$)/.test(key)));
      Object.assign(env, { CARDBUSH_RUNTIME_STATE_ROOT: root, CARDBUSH_RUNTIME_SKILL_ROOTS: '[]',
        CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]', CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' });
      if (mode === 'service') env.CARDBUSH_SERVICE_ID = 'fixture';
      if (mode === 'desktop') env.CARDBUSH_MCP_DESKTOP_BRIDGE = '1';
      for (const turnId of ['first', 'after-restart']) {
        runtime = new AgentRuntimeHost(env, async operation => {
          if (operation === 'network.configuration') return { mode: 'system' };
          if (operation === 'network.route') return '';
          throw Error(`Unexpected host operation: ${operation}`);
        });
        await runtime.ready;
        const command = (kind, payload = {}) => runtime.transport.sendCommand({ kind, payload });
        const { binding } = await command('runtime.upsert_provider_binding', { protocol: 'bush.provider_binding_config.v1',
          bindingId: 'fixture', adapter: 'openai_chat_completions', apiKey: 'fixture',
          baseURL: `http://127.0.0.1:${server.address().port}/v1` });
        const tools = (await command('runtime.get_tool_catalog')).filter(tool => tool.name === 'checkpoint_context');
        assert.equal(tools.length, 1);
        const terminal = await runtime.runOwnedCommand({ kind: 'runtime.run_session_turn', payload: {
          protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId, turnId,
          model: 'fixture', providerBinding: binding, tools, maxOutputTokens: 4000,
          prefixMessages: [{ role: 'system', content: 'Inspect existing reports only.' }],
          inputMessages: [{ messageId: `${turnId}-user`, message: { role: 'user', content: 'Check the existing reports.' } }],
          metadata: { contextWindowTokens: 20000, workspaceDir: root },
        } }, AbortSignal.timeout(20000));
        assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
        const compactions = await command('runtime.list_turn_context_compactions', { sessionId, turnId });
        if (turnId === 'first') {
          assert.ok(compactions.some(event => event.kind === 'context_compaction_completed' && event.payload.method === 'recorded_tool_handoff'));
        } else assert.equal(compactions.length, 0, 'restart reuses the committed projection');
        await runtime.close(); runtime = undefined;
      }
      assert.equal(requests.length, 2, 'one ordinary model request per turn; no summary requests');
      for (const request of requests) {
        const records = request.messages.filter(message => message.content?.startsWith('<recorded_tool_exchange>'))
          .flatMap(message => JSON.parse(message.content.split('\n')[1]).entries);
        assert.equal(records.length, 2);
        records.forEach((record, index) => {
          assert.equal(record.tool, 'read_file'); assert.equal(record.reason, `Inspect report ${index}`);
          assert.equal(record.receipt.report_id, `R-${index}`); assert.equal(record.receipt.published, false);
          assert.ok(record.receipt.content.omitted_chars > 50000);
          assert.ok(request.messages.some(message => message.content === `Report R-${index} was inspected; publication is still pending.`));
        });
      }
      const saved = new SessionStore({ persistence: { load: () => persistence.load(sessionId), append() { throw Error('Read only'); } } }).snapshot(sessionId);
      assert.deepEqual(saved.turns.slice(0, 2).map(turn => turn.messages), original, 'original receipts remain intact');
      assert.ok(saved.turns.slice(0, 2).every(turn => turn.contextToolHandoff?.projectionVersion === 'recorded_v1'));
    } finally {
      await runtime?.close(); persistence.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      assert.ok(resolve(root).startsWith(base + sep));
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
