import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Agent, createServer, request } from 'node:http';
import test from 'node:test';
import { OPENAI_PROBE_PROTOCOL, OpenAiProbeError, OpenAiProbeProtocolError, startOpenAiProbeLogin, probeOpenAiHostedTools } from './lib/openai-hosted-probe.mjs';
import { createOpenAiResultNormalizer } from './lib/openai-hosted-result.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const callback = (login, parameters, options = {}) => new Promise((resolve, reject) => {
  // Keep the loopback Host-header test independent of the user's system proxy.
  const agent = new Agent({ proxyEnv: {} });
  const url = new URL(login.redirectUri);
  url.search = new URLSearchParams({ state: new URL(login.authorizationUrl).searchParams.get('state'), code: 'fixture-code', ...parameters }).toString();
  const req = request({ agent, hostname: '127.0.0.1', port: url.port, path: url.pathname + url.search, method: options.method ?? 'GET',
    headers: { Host: url.host, ...options.headers } }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
    response.on('end', () => { agent.destroy(); resolve({ status: response.statusCode, headers: response.headers, body }); });
  });
  req.on('error', error => { agent.destroy(); reject(error); }); req.end();
});

test('independent OAuth binds state, callback origin and PKCE without reflecting credentials', async t => {
  const exchanges = [];
  const login = await startOpenAiProbeLogin({ ports: [0], fetch: async (url, init) => {
    exchanges.push({ url, init }); return json({ access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', token_type: 'Bearer' });
  } });
  t.after(() => login.close());
  assert.equal((await callback(login, { state: 'wrong-state' })).status, 400);
  assert.equal((await callback(login, {}, { headers: { Origin: 'https://untrusted.invalid' } })).status, 400);
  assert.equal((await callback(login, {}, { headers: { Host: 'untrusted.invalid' } })).status, 400);
  assert.equal((await callback(login, {}, { method: 'POST' })).status, 400);
  assert.equal(exchanges.length, 0);
  const response = await callback(login);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /fixture-access|fixture-refresh|fixture-code/);
  assert.equal((await login.result).access_token, 'fixture-access-secret');
  assert.equal(exchanges.length, 1);
  const [{ url, init }] = exchanges;
  assert.equal(url, OPENAI_PROBE_PROTOCOL.tokenEndpoint);
  assert.equal(init.redirect, 'error');
  assert.equal(init.body.get('redirect_uri'), login.redirectUri);
  assert.equal(init.body.get('grant_type'), 'authorization_code');
  assert.equal(init.body.get('code'), 'fixture-code');
  assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), new URL(login.authorizationUrl).searchParams.get('code_challenge'));
  assert.equal((await callback(login)).status, 409);
  assert.equal(exchanges.length, 1);
});

test('concurrent callbacks exchange once; cancellation aborts an in-flight exchange', async t => {
  const entered = deferred(); let exchanges = 0;
  const login = await startOpenAiProbeLogin({ ports: [0], fetch: async (_url, init) => {
    exchanges++; entered.resolve();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  t.after(() => login.close());
  const first = callback(login).catch(error => ({ disconnected: error.code }));
  await entered.promise;
  assert.equal((await callback(login)).status, 409);
  await login.close();
  await assert.rejects(login.result, /cancelled/);
  await first;
  assert.equal(exchanges, 1);
});

test('occupied callback listener survives fallback and login timeout', async t => {
  const existing = createServer((_request, response) => response.end('existing application'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const port = existing.address().port;
  const login = await startOpenAiProbeLogin({ ports: [port, 0], timeoutMs: 50 });
  t.after(() => login.close());
  assert.notEqual(Number(new URL(login.redirectUri).port), port);
  await assert.rejects(login.result, /timed out/);
  assert.equal(existing.listening, true);
  await assert.rejects(startOpenAiProbeLogin({ ports: [port] }), /occupied/);
  assert.equal(existing.listening, true);
});

test('token exchange failures and malformed responses never publish provider content', async t => {
  for (const [name, result] of [
    ['http_error', () => json({ error: 'fixture-secret-from-provider' }, 401)],
    ['wrong_token_type', () => json({ access_token: 'fixture-secret-from-provider', token_type: 'MAC' })],
    ['oversized', () => json({ access_token: 'fixture-secret-from-provider', padding: 'x'.repeat(2 * 1024 * 1024) })],
  ]) await t.test(name, async t => {
    const login = await startOpenAiProbeLogin({ ports: [0], fetch: async () => result() });
    t.after(() => login.close());
    const response = await callback(login);
    assert.equal(response.status, 502);
    assert.doesNotMatch(response.body, /fixture-secret/);
    await assert.rejects(login.result, error => { assert.doesNotMatch(error.message, /fixture-secret/); return true; });
  });
});

const profileTool = (appId, name, overrides = {}) => ({ name, inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false }, _meta: { connector_id: appId, resource_name: 'gmail.get_profile' }, ...overrides });
function hostedFixture(pages, toolResult = { content: [{ type: 'text', text: 'fixture-private-profile' }], structuredContent: { email: 'private@example.invalid' } }) {
  const calls = [], requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    assert.equal(String(url), OPENAI_PROBE_PROTOCOL.mcpEndpoint);
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-bearer');
    if (init.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    if (!('id' in message)) return new Response(null, { status: 202 });
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }; break;
      case 'tools/list': result = pages[message.params?.cursor ?? 'first']; break;
      case 'tools/call': calls.push(message.params); result = toolResult; break;
      default: throw new Error(`Unexpected fixture method: ${message.method}`);
    }
    return json({ jsonrpc: '2.0', id: message.id, result });
  };
  return { fetch, calls, requests };
}

test('direct MCP pages catalog, scopes by connector identity and never returns profile data in diagnostics', async () => {
  const fixture = hostedFixture({ first: { tools: [profileTool('other', 'other_profile')], nextCursor: 'next' }, next: {
    tools: [profileTool('gmail-id', 'app_only', { _meta: { connector_id: 'gmail-id', resource_name: 'gmail.get_profile', ui: { visibility: ['app'] } } }), profileTool('gmail-id', 'gmail_profile')],
  } });
  const facts = await probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: fixture.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile' });
  assert.equal(facts.catalogReady, true);
  assert.equal(facts.appCount, 2);
  assert.equal(facts.targetToolCount, 1);
  assert.equal(facts.readonlyCallSucceeded, true);
  assert.equal(facts.usesCodexProcess, false);
  assert.equal(facts.usesCodexCredentialFiles, false);
  assert.deepEqual(fixture.calls, [{ name: 'gmail_profile', arguments: {} }]);
  assert.doesNotMatch(JSON.stringify(facts), /fixture-bearer|fixture-private|private@example/);
});

test('probe refuses absent, destructive, non-readonly and argument-requiring tools', async t => {
  for (const [name, tool] of [
    ['wrong_app', profileTool('other', 'profile')],
    ['destructive', profileTool('gmail-id', 'profile', { annotations: { readOnlyHint: true, destructiveHint: true } })],
    ['no_readonly_hint', profileTool('gmail-id', 'profile', { annotations: {} })],
    ['required_argument', profileTool('gmail-id', 'profile', { inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } })],
  ]) await t.test(name, async () => {
    const fixture = hostedFixture({ first: { tools: [tool] } });
    await assert.rejects(probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: fixture.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile' }), /not available|only permits/);
    assert.equal(fixture.calls.length, 0);
  });
});

test('SDK bounds repeated cursors and upstream tool errors never publish response content', async () => {
  const repeated = hostedFixture({ first: { tools: [], nextCursor: 'repeat' }, repeat: { tools: [], nextCursor: 'repeat' } });
  await assert.rejects(probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: repeated.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile' }), /not available/);
  assert.equal(repeated.requests.filter(({ init }) => init.method === 'POST' && JSON.parse(init.body).method === 'tools/list').length, 2);
  const failed = hostedFixture({ first: { tools: [profileTool('gmail-id', 'profile')] } }, { isError: true, content: [{ type: 'text', text: 'fixture-private-failure' }] });
  await assert.rejects(probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: failed.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile' }), error => {
    assert.match(error.message, /hosted tool returned an error/); assert.doesNotMatch(error.message, /fixture-private/); return true;
  });
});

test('gateway diagnostics retain HTTP status and only allowlisted service codes', async () => {
  for (const message of ['no_biscuit_no_service', 'fixture-sensitive-upstream-content']) {
    await assert.rejects(probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: async () => json({ message }, 451) }), error => {
      assert.ok(error instanceof OpenAiProbeError);
      assert.equal(error.diagnostics.httpStatus, 451);
      assert.equal(error.diagnostics.serviceCode, message === 'no_biscuit_no_service' ? message : undefined);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /fixture-sensitive/);
      return true;
    });
  }
});

test('wire success and local schema rejection remain distinct without logging profile values', async () => {
  const tool = profileTool('gmail-id', 'profile', { outputSchema: {
    type: 'object', properties: { result: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } }, required: ['result'],
  } });
  const fixture = hostedFixture({ first: { tools: [tool] } }, { content: [], structuredContent: { email: 123 } });
  const progress = [];
  await assert.rejects(probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, {
    fetch: fixture.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile', onProgress: event => progress.push(event),
  }), error => {
    assert.ok(error instanceof OpenAiProbeProtocolError);
    assert.equal(error.diagnostics.phase, 'readonly_tool_call');
    assert.equal(error.diagnostics.protocolCode, -32602);
    assert.equal(error.diagnostics.facts.catalogReady, true);
    assert.equal(error.diagnostics.facts.wireToolReply.isError, false);
    assert.deepEqual(error.diagnostics.facts.wireToolReply.requiredFieldsMissing, ['result']);
    assert.equal(error.diagnostics.facts.readonlyCallSucceeded, false);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /private@example|fixture-private/);
    return true;
  });
  assert.deepEqual(progress.map(item => item.stage), ['mcp_connected', 'catalog_ready', 'readonly_tool_selected', 'readonly_wire_result']);
  assert.equal(fixture.calls.length, 1, 'diagnostics never repeat a tool call');
  const valid = hostedFixture({ first: { tools: [tool] } }, { content: [], structuredContent: { result: { email: 'private@example.invalid' } } });
  assert.equal((await probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: valid.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile' })).readonlyCallSucceeded, true);
});

test('OpenAI result envelope adaptation validates the full schema, preserves raw data and never weakens other contracts', async () => {
  const tool = profileTool('gmail-id', 'profile', { outputSchema: {
    type: 'object', properties: { result: { $ref: '#/$defs/Profile' } }, required: ['result'], additionalProperties: false,
    $defs: { Profile: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'], additionalProperties: false } },
  } });
  const normalize = createOpenAiResultNormalizer(tool);
  const raw = Object.freeze({ content: [{ type: 'text', text: 'fixture-private-profile' }], structuredContent: Object.freeze({ email: 'private@example.invalid' }), _meta: { original: true } });
  const adapted = normalize(raw);
  assert.equal(adapted.normalized, true);
  assert.equal(adapted.result.structuredContent.result, raw.structuredContent);
  assert.equal(adapted.result.content, raw.content);
  assert.equal(adapted.result._meta, raw._meta);
  assert.equal(Object.hasOwn(raw.structuredContent, 'result'), false);
  assert.equal(normalize(adapted.result).result, adapted.result, 'already valid envelopes are not changed');
  for (const invalid of [
    { ...raw, structuredContent: { email: 123 } },
    { ...raw, structuredContent: { email: 'not-an-email' } },
    { ...raw, structuredContent: { email: 'private@example.invalid', undeclared: true } },
    { ...raw, structuredContent: { result: { email: 123 } } },
    { ...raw, structuredContent: undefined },
    { ...raw, isError: true },
  ]) assert.equal(normalize(invalid).result, invalid);
  const multiField = { ...tool, outputSchema: { ...tool.outputSchema, properties: { ...tool.outputSchema.properties, meta: {} } } };
  assert.equal(createOpenAiResultNormalizer(multiField)(raw).normalized, false);
  const fixture = hostedFixture({ first: { tools: [tool] } }, raw);
  const facts = await probeOpenAiHostedTools({ access_token: 'fixture-bearer' }, { fetch: fixture.fetch, appId: 'gmail-id', resourceName: 'gmail.get_profile' });
  assert.equal(facts.readonlyCallSucceeded, true);
  assert.equal(facts.outputNormalization, 'validated_declared_result_envelope');
  assert.deepEqual(facts.wireToolReply.requiredFieldsMissing, ['result']);
  assert.doesNotMatch(JSON.stringify(facts), /private@example|fixture-private/);
  assert.equal(fixture.calls.length, 1);
});
