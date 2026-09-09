import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, inputRequired, createMcpHandler } from '@modelcontextprotocol/server';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';
import { z } from 'zod';

for (const versionMode of ['legacy', 'modern']) {
  test(`${versionMode}: forms preserve concurrent task ownership and exclude user wait from the tool deadline`, async () => {
    const seen = [];
    const fixture = await setup(versionMode, async ({ sessionId, params }) => {
      seen.push({ sessionId, message: params.message });
      await new Promise(resolve => setTimeout(resolve, 300));
      return { action: 'accept', content: { value: sessionId } };
    });
    try {
      const results = await Promise.all(['session-a', 'session-b'].map(sessionId => fixture.call(sessionId, 200)));
      assert.deepEqual(results.map(value => JSON.parse(value.content[0].text).content.value), ['session-a', 'session-b']);
      assert.deepEqual(seen.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
        { sessionId: 'session-a', message: 'session-a' }, { sessionId: 'session-b', message: 'session-b' },
      ]);
    } finally { await fixture.close(); }
  });

  test(`${versionMode}: cancelling a parent tool cancels its pending user request`, async () => {
    let entered, signal;
    const began = new Promise(resolve => { entered = resolve; });
    const fixture = await setup(versionMode, async (_input, activeSignal) => {
      signal = activeSignal; entered();
      return new Promise(resolve => activeSignal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true }));
    });
    try {
      const cancel = new AbortController();
      const call = fixture.call('cancelled', 500, cancel.signal);
      await began; cancel.abort();
      await assert.rejects(call);
      assert.equal(signal.aborted, true);
    } finally { await fixture.close(); }
  });
}

test('an unavailable optional server cannot prevent healthy servers from supplying tools', async () => {
  const registry = new ToolRegistry();
  const pair = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'fixture', version: '1' });
  server.registerTool('echo', { inputSchema: z.object({}) }, async () => ({ content: [] }));
  await server.connect(pair[1]);
  const manager = new McpClientManager({ registry, createTransport: config => config.id === 'healthy' ? pair[0] : {
    start: async () => { throw new Error('offline fixture'); }, close: async () => {}, send: async () => {},
  } });
  try {
    const result = await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'optional', revision: 1,
      servers: ['broken', 'healthy'].map(id => ({ id, versionMode: 'legacy', transport: { kind: 'stdio', command: 'fixture' } })) });
    assert.equal(result.applicationState, 'applied');
    assert.deepEqual(result.servers.map(item => item.health), ['unavailable', 'ready']);
    assert.ok(registry.resolve('mcp__healthy__echo'));
  } finally { await manager.close(); await server.close(); }
});

async function setup(versionMode, onElicitation) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const buildServer = () => { const server = new McpServer({ name: 'elicitation-fixture', version: '1' });
  server.registerTool('form', { inputSchema: z.object({ session: z.string() }) }, async ({ session }, context) => {
    const params = { message: session, requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } };
    if (versionMode === 'modern') {
      const response = context.mcpReq.inputResponses?.form;
      if (!response) return inputRequired({ inputRequests: { form: inputRequired.elicit(params) }, requestState: 'opaque-state' });
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const response = await context.mcpReq.elicitInput(params);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  });
  return server; };
  const server = buildServer();
  let httpServer, endpoint;
  if (versionMode === 'legacy') await server.connect(serverTransport);
  else {
    const handler = createMcpHandler(buildServer);
    httpServer = createServer(async (request, response) => {
      const chunks=[]; for await (const chunk of request) chunks.push(chunk);
      const result=await handler.fetch(new Request(endpoint, {method:request.method,headers:request.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}));
      response.writeHead(result.status,Object.fromEntries(result.headers)).end(await result.text());
    });
    await new Promise(resolve => httpServer.listen(0,'127.0.0.1',resolve));
    endpoint='http://127.0.0.1:'+httpServer.address().port+'/mcp';
  }
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, onElicitation, ...(versionMode === 'legacy' ? {createTransport: () => clientTransport} : {}) });
  await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'forms', revision: 1,
    servers: [{ id: 'forms', versionMode, transport: versionMode === 'legacy' ? { kind: 'stdio', command: 'fixture' } : {kind:'streamable_http',url:endpoint} }] });
  assert.equal(manager.snapshot().servers[0].health, 'ready', manager.snapshot().servers[0].lastError);
  const tool = registry.mcpHook('forms', 'form');
  return {
    call: (sessionId, timeoutMs, signal) => tool.call({ session: sessionId }, { timeoutMs, signal, request: { requestId: 'r-' + sessionId, sessionId, turnId: 'turn', metadata: {} } }),
    close: async () => { await manager.close(); await server.close(); if(httpServer) await new Promise(resolve=>{httpServer.close(resolve);httpServer.closeAllConnections();}); },
  };
}
