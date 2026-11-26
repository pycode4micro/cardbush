import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantEvents } from '../dist/assistantEvents.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { CollectorReadError } from '../dist/eventCollector.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { PERSONAL_ASSISTANT_SESSION as sessionId } from '@cardbush/bush-protocol';
import { uiText } from '@cardbush/platform/i18n';

async function until(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 5)); }
  assert.fail('The monitor did not reach the expected state.');
}
async function fixture(t, { language = 'en', collector } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-monitor-failure-'));
  const journal = new ConversationJournal(join(root, 'journal'));
  let time = 0, timer, service, registry, failDelivery = false, requests = 0, deliveries = 0;
  const clock = { schedule(wake, delay) { timer = { wake, at: time + delay }; }, cancel(wake) { if (timer?.wake === wake) timer = undefined; } };
  const configuration = { action: 'configure', assistant: { name: 'Assistant' },
    profile: { name: 'Assistant', language, timeZone: 'UTC', confirmedAt: '2026-11-15T00:00:00Z', recognition: {} },
    parent: { protocol: 'bush.session_turn_request.v1', sessionId, requestId: 'config', turnId: 'config', model: 'fixture',
      tools: [], metadata: { uiLanguage: language }, permissionMode: 'ask_for_approval', prefixMessages: [],
      inputMessages: [{ messageId: 'config', message: { role: 'user', content: 'configure' } }] } };
  const open = async () => {
    registry = new ToolRegistry();
    service = new AssistantEvents(join(root, 'events.json'), { tools: registry, clock, collector, now: () => time,
      run: async () => { requests++; assert.fail('Failure notifications must not request a model.'); },
      publish: notice => {
        deliveries++;
        journal.append(sessionId, { id: notice.turnId, eventId: notice.eventId, createdAt: notice.createdAt,
          role: 'assistant', source: 'page', visibility: 'conversation', content: notice.text });
        if (failDelivery) throw Error('Simulated lost delivery acknowledgement');
      },
    });
    await service.command(configuration);
  };
  await open();
  t.after(async () => {
    await service.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-monitor-failure-'));
    await rm(root, { recursive: true, force: true });
  });
  return {
    get service() { return service; }, get requests() { return requests; }, get deliveries() { return deliveries; },
    notices: () => journal.read(sessionId),
    async restart() { await service.close(); await open(); },
    setDeliveryFailure(value) { failDelivery = value; },
    async advance(at, beforeWake) { await until(() => timer, value => value?.at === at); time = at; beforeWake?.(); timer.wake(); },
    async invoke(args) {
      const tool = registry.resolve('assistant_event');
      return tool.execute({ sessionId, toolCall: { id: randomUUID() }, input: tool.decodeInput(args),
        turn: { request: { turnId: 'user-turn', metadata: { assistantUserRequest: true } } } });
    },
  };
}

for (const language of ['zh', 'en']) test(`runtime detector failure is localized, durable and delivered once after a lost acknowledgement (${language})`, async t => {
  const f = await fixture(t, { language });
  const receipt = await f.invoke({ action: 'subscribe', topic: 'Broken monitor', text: 'Watch tool outcomes', trigger: { source: 'runtime', code: 'return 2;' } });
  f.setDeliveryFailure(true);
  await f.service.observeRuntime({ kind: 'tool_returned', nowMs: 1, status: 'completed' }, 'one');
  const failed = await f.invoke({ action: 'read', eventId: receipt.eventId });
  assert.equal(failed.status, 'failed');
  assert.equal(f.notices()[0].content, uiText(language)('assistantEvent.monitoringFailed', { title: failed.title, code: 'EVENT_TRIGGER_EXPECTED_ZERO_OR_ONE' }));
  assert.equal((await f.service.store.read()).notifications.length, 1);
  const failedAttempts = f.deliveries;
  if (language === 'zh') {
    f.setDeliveryFailure(false); await f.restart();
  } else {
    // A running host must retry its durable outbox without needing a restart.
    await f.advance(30000, () => f.setDeliveryFailure(false));
    await until(() => f.service.store.read(), state => !state.notifications?.length);
  }
  assert.ok(f.deliveries > failedAttempts, 'delivery is retried after the acknowledgement is lost');
  assert.equal(f.notices().length, 1, 'the journal consumes the stable notice ID once');
  assert.equal((await f.service.store.read()).notifications?.length ?? 0, 0);
  const deliveredAttempts = f.deliveries;
  await f.restart();
  assert.equal(f.deliveries, deliveredAttempts, 'a consumed notice is not delivered on another restart');
  await f.service.observeRuntime({ kind: 'tool_returned', nowMs: 2, status: 'completed' }, 'two');
  assert.equal(f.notices().length, 1); assert.equal(f.requests, 0);
  assert.equal((await f.service.snapshot()).detections.length, 0);
});

test('collector retries remain quiet until exhausted, then notify without model work', async t => {
  const f = await fixture(t, { collector: { resolve: async () => ({ version: 'v1', toolCallId: 'sample', sample: {},
    read: async () => { throw new CollectorReadError('offline'); } }) } });
  const { eventId } = await f.invoke({ action: 'subscribe', topic: 'Offline source', text: 'Watch source changes',
    trigger: { source: 'collector', taskId: 'verified-task', tool: 'read_fixture', everySeconds: 1, code: 'return 0;' } });
  for (const [index, at] of [1000, 31000, 91000].entries()) {
    await f.advance(at);
    await until(() => f.service.snapshot(), state => state.events[0].collectorFailures === index + 1);
    if (index < 2) assert.equal(f.notices().length, 0);
  }
  await until(f.notices, notices => notices.length === 1);
  assert.equal((await f.invoke({ action: 'read', eventId })).status, 'failed');
  assert.equal((await f.service.snapshot()).detections.length, 0);
  await f.restart(); assert.equal(f.notices().length, 1); assert.equal(f.requests, 0);
});

test('valid false observations stay silent while a changed collector source stops and notifies', async t => {
  let version = 'v1', reads = 0;
  const f = await fixture(t, { collector: { resolve: async () => ({ version, toolCallId: 'sample', sample: {},
    read: async () => { reads++; return {}; } }) } });
  const { eventId } = await f.invoke({ action: 'subscribe', topic: 'Quiet source', text: 'Watch source changes',
    trigger: { source: 'collector', taskId: 'verified-task', tool: 'read_fixture', everySeconds: 1, code: 'return 0;' } });
  await f.advance(1000); await until(() => reads, count => count === 1);
  await f.advance(2000); await until(() => reads, count => count === 2);
  assert.equal(f.notices().length, 0);
  version = 'v2'; await f.advance(3000);
  await until(f.notices, notices => notices.length === 1);
  assert.equal((await f.invoke({ action: 'read', eventId })).error, 'EVENT_COLLECTOR_SOURCE_CHANGED');
  assert.equal(reads, 2); assert.equal(f.requests, 0);
});
