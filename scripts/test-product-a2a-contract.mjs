import assert from 'node:assert/strict';

import {
  ProductA2AClient,
  productA2AAllowedOrigins,
} from '../dist-electron/productA2A.js';

const calls = [];
const client = new ProductA2AClient({
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/.well-known/agent-card.json')) {
      return response({ name: 'Fixture Agent', protocolVersions: ['1.0'] });
    }
    return response({
      task: {
        id: 'task_fixture',
        contextId: 'context_fixture',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ text: 'done' }] }],
      },
    });
  },
});

const card = await client.inspect('http://127.0.0.1:9000/base');
assert.equal(card.name, 'Fixture Agent');
assert.equal(calls[0].url, 'http://127.0.0.1:9000/.well-known/agent-card.json');

const dispatched = await client.dispatch({
  agentUrl: 'http://127.0.0.1:9000/base',
  text: 'do the work',
  contextId: 'context_fixture',
});
assert.equal(dispatched.task.id, 'task_fixture');
assert.equal(calls[1].url, 'http://127.0.0.1:9000/base/message:send');
assert.equal(calls[1].init.headers['A2A-Version'], '1.0');
const request = JSON.parse(calls[1].init.body);
assert.equal(request.message.role, 'ROLE_USER');
assert.deepEqual(request.message.parts, [{ text: 'do the work' }]);

await assert.rejects(
  () => client.inspect('https://example.com'),
  /allowlist/,
);
await assert.rejects(
  () => client.inspect('http://user:secret@127.0.0.1:9000'),
  /credentials/,
);
await assert.rejects(
  () => client.dispatch({
    agentUrl: 'http://127.0.0.1:9000',
    text: 'x'.repeat(256 * 1024 + 1),
  }),
  /exceeds/,
);

const allowlisted = new ProductA2AClient({
  allowedOrigins: productA2AAllowedOrigins('https://agents.example, https://other.example'),
  fetchImpl: async () => response({ name: 'Remote' }),
});
assert.equal((await allowlisted.inspect('https://agents.example/path')).name, 'Remote');

const oversized = new ProductA2AClient({
  fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
});
await assert.rejects(
  () => oversized.inspect('http://localhost:9000'),
  /exceeds/,
);

console.log('Product A2A contract passed.');

function response(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/a2a+json' },
  });
}
