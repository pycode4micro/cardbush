import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AgentRuntimeHost } from '../dist-electron/agentRuntimeHost.mjs';

// Exercise the actual shared worker, including its host bridge and task registry.
// All model responses and SSH observations are local fixtures; no command runs.
for (const mode of ['standalone', 'service', 'desktop', 'desktop-disconnected']) {
  test(`shared worker task sources reflect ${mode} SSH capability`, { timeout: 30000 }, async () => {
    const base = resolve('tmp/runtime-ssh-capability'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'case-'));
    let requests = 0, sshRequests = 0, runtime;
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), first = ++requests === 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = first ? { tool_calls: [{ index: 0, id: 'tasks-call', type: 'function', function: { name: 'tasks', arguments: '{"action":"list"}' } }] } : { content: 'Done.' };
      response.write(`data: ${JSON.stringify({ id: `fixture-${requests}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: `fixture-${requests}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARDBUSH_')));
      Object.assign(env, { CARDBUSH_RUNTIME_STATE_ROOT: root, CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]', CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' });
      // Service identity must win even if a desktop flag was accidentally supplied.
      if (mode === 'service') env.CARDBUSH_SERVICE_ID = 'fixture-service';
      if (mode !== 'standalone') env.CARDBUSH_MCP_DESKTOP_BRIDGE = '1';
      runtime = new AgentRuntimeHost(env, async (operation, payload) => {
        if (operation === 'network.configuration') return { mode: 'system' };
        if (operation === 'network.route') return '';
        if (operation === 'ssh.workspace') {
          sshRequests++;
          assert.equal(payload.action, 'terminals'); assert.equal(payload.owner, 'session');
          if (mode === 'desktop-disconnected') throw Error('Fixture SSH connection unavailable');
          if (mode !== 'desktop') throw Error('This Agent does not provide ssh.workspace.');
          return { sessions: [{ terminalSessionId: 'ssh-terminal', command: 'fixture', state: 'exited', exitCode: 0, uri: 'ssh://fixture/work' }] };
        }
        throw Error(`Unexpected host request: ${operation}`);
      });
      await runtime.ready;
      const command = (kind, payload = {}) => runtime.transport.sendCommand({ kind, payload });
      const { binding } = await command('runtime.upsert_provider_binding', { protocol: 'bush.provider_binding_config.v1', bindingId: 'fixture',
        adapter: 'openai_chat_completions', apiKey: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1` });
      const tools = (await command('runtime.get_tool_catalog')).filter(tool => tool.name === 'tasks');
      assert.equal(tools.length, 1);
      const completed = await runtime.runOwnedCommand({ kind: 'runtime.run_model_turn', payload: { protocol: 'bush.model_request.v1',
        requestId: 'request', sessionId: 'session', turnId: 'turn', model: 'fixture', providerBinding: binding,
        tools, messages: [{ role: 'user', content: 'List task status.' }], metadata: { workspaceDir: root } } }, AbortSignal.timeout(20000));
      assert.equal(completed.payload.status, 'completed'); assert.equal(requests, 2);
      const record = await command('runtime.get_tool_execution', { sessionId: 'session', turnId: 'turn', toolCallId: 'tasks-call' });
      assert.equal(record.outcome, 'returned'); assert.equal(record.resultError, undefined);
      if (mode === 'desktop') {
        assert.equal(sshRequests, 1); assert.equal(record.result.tasks[0].task_id, 'ssh-terminal');
        assert.equal(record.result.tasks[0].status, 'completed'); assert.equal(record.result.complete, undefined);
      } else if (mode === 'desktop-disconnected') {
        assert.equal(sshRequests, 1); assert.equal(record.result.complete, false);
        assert.match(record.result.unavailable_sources[0], /SSH connection unavailable/);
      } else {
        assert.equal(sshRequests, 0); assert.equal(record.result.complete, undefined);
        assert.equal(record.result.unavailable_sources, undefined); assert.deepEqual(record.result.tasks, []);
      }
    } finally {
      await runtime?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
