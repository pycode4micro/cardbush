import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
export async function oauthServer(options = {}) {
  let base, registered, authorization, token = 'fixture-access-1';
  const counters = { registrations: 0, codes: 0, refreshes: 0, calls: 0 };
  const observations = {};
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, base);
      const json = (value, status = 200, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(value)); };
      const metadataPath = options.resourceMetadataPath ?? '/.well-known/oauth-protected-resource';
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return options.resourceMetadataPath && url.pathname !== metadataPath ? json({}, 404)
        : json({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: options.scopes ?? ['tools:read'] });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base,
        authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', ...(options.clientId ? {} : { registration_endpoint: base + '/register' }),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: [options.clientSecret ? 'client_secret_post' : 'none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/register') {
        registered = JSON.parse(body); counters.registrations++;
        return json({ ...registered, client_id: 'fixture-client', client_id_issued_at: 1 }, 201);
      }
      if (url.pathname === '/authorize') {
        authorization = url;
        assert.equal(url.searchParams.get('client_id'), options.clientId ?? 'fixture-client');
        assert.equal(url.searchParams.get('resource'), base + '/mcp');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        const redirect = new URL(url.searchParams.get('redirect_uri'));
        if (registered) assert.ok(registered.redirect_uris.includes(redirect.toString()));
        observations.redirectUri = redirect.toString(); observations.scope = url.searchParams.get('scope');
        redirect.searchParams.set('state', url.searchParams.get('state'));
        redirect.searchParams.set('code', 'fixture-code'); redirect.searchParams.set('iss', base);
        response.writeHead(302, { location: redirect.toString() }).end(); return;
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body);
        if (options.clientSecret) assert.equal(params.get('client_secret'), options.clientSecret);
        assert.equal(params.get('resource'), base + '/mcp');
        if (params.get('grant_type') === 'refresh_token') {
          assert.equal(params.get('refresh_token'), 'fixture-refresh'); counters.refreshes++; token = 'fixture-access-2';
        } else {
          assert.equal(params.get('code'), 'fixture-code');
          assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
          counters.codes++;
        }
        return json({ access_token: token, token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 3600, scope: 'tools:read' });
      }
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        const message = JSON.parse(body);
        if (message.method === 'tools/call') {
          counters.calls++;
          (observations.calls ??= []).push(message.params);
          if (options.callStatus) return json({ error: 'fixture failure' }, options.callStatus);
        }
        const publicMethod = options.publicDiscovery && ['initialize', 'notifications/initialized', 'tools/list'].includes(message.method);
        if (!publicMethod && (request.headers.authorization !== `Bearer ${token}` || options.rejectCalls && message.method === 'tools/call')) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}${metadataPath}"` });
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', serverInfo: { name: 'oauth-fixture', version: '1' }, capabilities: { tools: {} } }
          : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] }
            : { content: [{ type: 'text', text: message.params.arguments.value }] };
        return json({ jsonrpc: '2.0', id: message.id, result });
      }
      json({}, 404);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: base, counters, observations, expire: () => { token = 'expired'; }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
