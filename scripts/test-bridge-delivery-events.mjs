import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ContextWebhookHost } from '../dist-electron/contextWebhookHost.mjs';

test('delivery observations authenticate their source, survive acknowledgement races and refresh read-only status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-delivery-')), notifications = [], received = [];
  let gateway, generation = 0, status = 'queued', early;
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (payload.type !== 'tool.call') { res.end('{}'); return; }
    received.push(payload);
    if (early && payload.tool === 'send_text') await early(payload);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: payload.eventId, status: 'accepted',
      result: { deliveryId: payload.tool === 'send_text' ? payload.eventId : payload.arguments.delivery_id,
        status, deliveryConfirmed: status === 'delivered' } }));
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const runtime = { command: async (kind, value) => {
    if (value.action === 'delivery-update') notifications.push(value);
    return { generation };
  } };
  const cipher = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
  gateway = await new ContextWebhookHost(root, cipher, runtime, { port: 0, execute: async () => ({ status: 'completed', reply: 'OK' }) }).start();
  t.after(async () => { await gateway.close(); receiver.closeAllConnections(); await new Promise(r => receiver.close(r)); await rm(root, { recursive: true, force: true }); });
  const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'request', turnId: 'turn', sessionId: 'personal-assistant', model: 'fixture', tools: [],
    prefixMessages: [], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Send' } }], permissionMode: 'all_free', metadata: {} };
  const saved = await gateway.command({ action: 'save', binding: { kind: 'assistant', sessionId: 'personal-assistant', title: 'Fixture', parent, profile: { name: 'Assistant' }, generation: 0 },
    config: { name: 'Fixture', enabled: true, url: `http://127.0.0.1:${receiver.address().port}/reply`, headers: {}, parameters: {}, body: { reply: '{{reply}}' },
      incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } } });
  const connection = saved.connections[0];
  const post = (path, body, token = connection.token) => fetch(connection.endpoint.replace(/\/messages$/, path), { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/messages', { messageId: 'original', senderId: 'owner', conversationId: 'room', text: 'Send requested image.' });
  const schema = { type: 'object', properties: { delivery_id: { type: 'string' } }, additionalProperties: false };
  const ack = await (await post('/capabilities', { protocol: 'cardbush.webhook.v1', capabilities: { text: true }, plugins: [{ id: 'fixture', name: 'Fixture', version: '1', description: 'Fixture',
    tools: [{ name: 'send_text', description: 'Send text', inputSchema: schema }, { name: 'delivery_status', description: 'Read delivery', readOnly: true, inputSchema: schema }] }] })).json();
  assert.ok(ack.features.includes('delivery_events'));
  const source = (await gateway.botRequest({ action: 'context', sessionId: 'personal-assistant' })).targets[0];
  const catalog = await gateway.botRequest({ action: 'catalog', sessionId: 'personal-assistant' });
  const call = (tool, requestId, args = {}) => gateway.botRequest({ action: 'call', sessionId: 'personal-assistant', input: {
    connectionId: connection.id, pluginId: 'fixture', revision: catalog[0].revision, sourceRef: source.sourceRef, tool, requestId, arguments: args } });
  const result = id => ({ deliveryId: id, status: 'delivered', deliveryConfirmed: true, textPartsSent: 1, filesSent: 1 });
  const report = id => ({ protocol: 'cardbush.webhook.v1', eventId: id, sourceRef: source.sourceRef, messageId: 'original', result: result(id) });
  early = async payload => { assert.equal((await post('/deliveries', report(payload.eventId))).status, 200); };
  const send = await call('send_text', 'send-1');
  assert.equal(send.result.status, 'delivered', 'a late queued ack cannot replace the terminal fact');
  assert.equal(send.deliveryConfirmed, true); assert.equal(notifications.length, 1);
  await post('/deliveries', report(send.eventId)); assert.equal(notifications.length, 1);
  assert.equal((await post('/deliveries', report(send.eventId), 'wrong-token')).status, 401);
  assert.equal((await post('/deliveries', { ...report(send.eventId), messageId: 'other-message' })).status, 404);
  assert.equal((await post('/deliveries', { ...report(send.eventId), result: { ...result(send.eventId), status: 'failed', deliveryConfirmed: false } })).status, 409);
  assert.equal((await call('send_text', 'send-1')).eventId, send.eventId); assert.equal(received.length, 1, 'send retries remain idempotent');
  assert.equal((await call('delivery_status', 'send-1', { delivery_id: send.eventId })).code, 'request_id_conflict');
  assert.equal((await call('delivery_status', 'query-1', { delivery_id: send.eventId })).result.status, 'queued');
  status = 'delivered';
  const fresh = await call('delivery_status', 'query-1', { delivery_id: send.eventId });
  assert.equal(fresh.result.status, 'delivered'); assert.equal(fresh.deliveryConfirmed, true);
  generation = 1; early = undefined;
  const afterReset = await call('send_text', 'after-reset'); assert.equal(afterReset.code, 'context_reset');
  generation = 0; const late = await call('send_text', 'late'); generation = 1;
  assert.equal((await post('/deliveries', report(late.eventId))).status, 200);
  assert.equal(notifications.length, 1, 'old context delivery cannot wake a reset Assistant');
});
