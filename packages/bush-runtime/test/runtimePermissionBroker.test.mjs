import assert from "node:assert/strict";
import test from "node:test";

import { RuntimePermissionBroker } from "../dist/index.js";

test('approval journal failure keeps the permission pending and never releases execution', async () => {
  let fail = true, released = 0, recorded = 0;
  const broker = new RuntimePermissionBroker({ createPermissionId: () => 'durable', onAnswered: () => {
    if (fail) throw new Error('Fixture journal is full');
    recorded++;
  } });
  const waiting = broker.request({ reason: 'Fixture', toolCallId: 'tool', actions: ['write'], targets: [{ kind: 'opaque', value: 'fixture' }], capabilityIds: ['fixture:write'] });
  void waiting.then(() => released++);
  const answer = { protocol: 'bush.runtime_permission_answer.v1', permissionId: 'durable', answerId: 'answer', decision: 'allow_once', grantedCapabilityIds: ['fixture:write'] };
  assert.throws(() => broker.answer(answer), /journal is full/);
  await Promise.resolve();
  assert.equal(released, 0, 'a failed durable decision must not grant access');
  assert.deepEqual(broker.pendingIds(), ['durable']);
  fail = false; broker.answer(answer); await waiting;
  assert.equal(recorded, 1); assert.equal(released, 1);
  assert.throws(() => broker.answer(answer), { code: 'permission_not_pending' });
});

test('cancellation journal failure rejects the waiter without escaping the abort listener', async () => {
  let abort;
  const signal = { aborted: false, addEventListener: (_, callback) => { abort = callback; }, removeEventListener() {} };
  const broker = new RuntimePermissionBroker({ createPermissionId: () => 'cancel', onCancelled: () => { throw new Error('Fixture cancellation journal is full'); } });
  const waiting = broker.request({ reason: 'Fixture', toolCallId: 'tool', actions: ['write'], targets: [{ kind: 'opaque', value: 'fixture' }], capabilityIds: ['fixture:write'] }, signal);
  const rejected = assert.rejects(waiting, /cancellation journal is full/);
  assert.doesNotThrow(() => abort());
  await rejected;
  assert.deepEqual(broker.pendingIds(), []);
});

test('aborting one coalesced waiter after a journal failure never grants it on another client retry', async () => {
  const controller = new AbortController(); let fail = true, cancelled = 0;
  const broker = new RuntimePermissionBroker({ createPermissionId: () => 'coalesced', onAnswered: () => { if (fail) throw new Error('offline journal'); }, onCancelled: () => cancelled++ });
  const common = { reason: 'Fixture', actions: ['write'], targets: [{ kind: 'opaque', value: 'fixture' }], capabilityIds: ['fixture:write'] };
  const first = broker.request({ ...common, toolCallId: 'first' }, controller.signal), second = broker.request({ ...common, toolCallId: 'second' });
  const answer = { protocol: 'bush.runtime_permission_answer.v1', permissionId: 'coalesced', answerId: 'answer', decision: 'allow_session', grantedCapabilityIds: common.capabilityIds };
  assert.throws(() => broker.answer(answer), /offline journal/);
  controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  fail = false; broker.answer(answer); assert.equal((await second).answerId, 'answer');
  assert.equal(cancelled, 0); assert.deepEqual(broker.pendingIds(), []);
});

test('an approval callback cannot reenter the same decision or resurrect a cancelled waiter', async () => {
  const controller = new AbortController(); let recorded = 0;
  const answer = { protocol: 'bush.runtime_permission_answer.v1', permissionId: 'reentrant', answerId: 'answer', decision: 'allow_once', grantedCapabilityIds: ['fixture:write'] };
  const broker = new RuntimePermissionBroker({ createPermissionId: () => 'reentrant', onAnswered: () => {
    recorded++; assert.throws(() => broker.answer(answer), { code: 'permission_not_pending' }); controller.abort();
  } });
  const waiting = broker.request({ reason: 'Fixture', toolCallId: 'tool', actions: ['write'], targets: [{ kind: 'opaque', value: 'fixture' }], capabilityIds: ['fixture:write'] }, controller.signal);
  broker.answer(answer); await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(recorded, 1); assert.deepEqual(broker.pendingIds(), []);
});

test('cancelled and already answered permissions reject late answers without dispatching or adding grants', async () => {
  for (const cancel of [true, false]) {
    let answered = 0, cancelled = 0;
    const broker = new RuntimePermissionBroker({ createPermissionId: () => 'race', onAnswered: () => answered++, onCancelled: () => cancelled++ });
    const controller = new AbortController();
    const waiting = broker.request({ reason: 'Fixture', toolCallId: 'tool', actions: ['write'], targets: [{ kind: 'opaque', value: 'fixture' }], capabilityIds: ['fixture:write'] }, controller.signal);
    const answer = { protocol: 'bush.runtime_permission_answer.v1', permissionId: 'race', answerId: 'answer', decision: 'allow_once', grantedCapabilityIds: ['fixture:write'] };
    if (cancel) { controller.abort(); await assert.rejects(waiting, { name: 'AbortError' }); }
    else { broker.answer(answer); await waiting; }
    assert.throws(() => broker.answer(answer), { code: 'permission_not_pending' });
    assert.equal(answered, cancel ? 0 : 1); assert.equal(cancelled, cancel ? 1 : 0);
    assert.deepEqual(broker.pendingIds(), []);
  }
});

test("coalesces simultaneous identical capability requests into one user decision", async () => {
  const requested = [];
  let permissionIndex = 0;
  const broker = new RuntimePermissionBroker({
    createPermissionId: () => `permission_${++permissionIndex}`,
    onRequested: (request) => requested.push(request),
  });
  const common = {
    reason: "read requires access outside the task roots.",
    actions: ["read"],
    targets: [{ kind: "filesystem_path", value: "C:\\workspace" }],
    capabilityIds: ["capability_read_workspace"],
  };
  const first = broker.request({ ...common, toolCallId: "call_1" });
  const second = broker.request({ ...common, toolCallId: "call_2" });

  assert.equal(requested.length, 1);
  assert.deepEqual(broker.pendingIds(), ["permission_1"]);
  broker.answer({
    protocol: "bush.runtime_permission_answer.v1",
    permissionId: "permission_1",
    answerId: "answer_1",
    decision: "allow_once",
    grantedCapabilityIds: ["capability_read_workspace"],
  });

  assert.equal((await first).answerId, "answer_1");
  assert.equal((await second).answerId, "answer_1");
  assert.deepEqual(broker.pendingIds(), []);
});

test("keeps distinct capabilities as distinct permission requests", () => {
  const requested = [];
  let permissionIndex = 0;
  const broker = new RuntimePermissionBroker({
    createPermissionId: () => `permission_${++permissionIndex}`,
    onRequested: (request) => requested.push(request),
  });
  void broker.request({
    reason: "read one",
    toolCallId: "call_1",
    actions: ["read"],
    targets: [{ kind: "filesystem_path", value: "C:\\one" }],
    capabilityIds: ["capability_one"],
  });
  void broker.request({
    reason: "read two",
    toolCallId: "call_2",
    actions: ["read"],
    targets: [{ kind: "filesystem_path", value: "C:\\two" }],
    capabilityIds: ["capability_two"],
  });
  assert.equal(requested.length, 2);
  assert.deepEqual(broker.pendingIds(), ["permission_1", "permission_2"]);
});
