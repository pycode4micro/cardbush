import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { FileSessionEventPersistence, InMemoryRuntimeHost, SessionStore } from '../dist/index.js';

test('first submission summarizes authored text once, persists across restart and isolates title failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-title-'));
  const persistence = new FileSessionEventPersistence({ root });
  const sessions = new SessionStore({ persistence });
  const calls = [];
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, provider: { async *stream(request) {
    const title = request.metadata.runtimeMaintenance === 'conversation_title';
    if (title) calls.push(request);
    if (title && request.sessionId === 'fallback') throw Error('provider unavailable');
    const base = { protocol:'bush.model_event.v1', requestId:request.requestId, createdAt:new Date().toISOString() };
    yield { ...base, sequence:0, kind:'response_started' };
    const titleText = request.sessionId === 'overlong' ? '👩🏽‍💻'.repeat(24) : '竞品分级调研';
    yield { ...base, sequence:1, kind:'text_delta', delta:title ? titleText : '普通回复' };
    yield { ...base, sequence:2, kind:'response_completed', finishReason:'stop' };
  } } });
  t.after(async () => { await host.sendCommand({ kind:'runtime.shutdown', payload:{} }); persistence.close(); await rm(root, { recursive:true, force:true }); });
  const authored = '请调研这些品牌，按目标、同级和新锐三类整理竞品';
  const send = (sessionId, turn) => host.runSessionTurn(createProductAgentTurnRequest({
    sessionId, turnId: turn, messageId: 'msg-' + turn, requestId: 'req-' + turn, createdAt: new Date().toISOString(),
    model:'test-model', tools:[], permissionMode:'task_free', planEnabled:false,
    userText:'Private resolved document contents', userMessageMetadata:{composerReferenceContent: authored},
  }));
  for (const id of ['automatic','fallback','manual','overlong']) {
    sessions.ensureSession(id, id === 'manual' ? { title: '保留自定义名称' } : { title:'New chat', titleGeneration:'pending' });
    assert.equal((await send(id, id + '-one')).payload.status, 'completed');
  }
  assert.equal((await send('automatic', 'two')).payload.status, 'completed');
  assert.equal(calls.length, 3);
  assert.equal(sessions.snapshot('overlong').metadata.title, '👩🏽‍💻'.repeat(19) + '…');
  assert.deepEqual(calls[0].messages.map(row => row.role), ['system','user']);
  assert.equal(calls[0].messages[1].content, authored);
  assert.match(calls[0].messages[0].content, /20 characters/);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(sessions.snapshot('manual').metadata.title, '保留自定义名称');
  const fallback = sessions.snapshot('fallback').metadata;
  assert.equal(fallback.titleGeneration, 'fallback');
  assert.equal([...fallback.title].length, 20);
  const restoredJournal = new FileSessionEventPersistence({ root });
  try {
    const restored = new SessionStore({ persistence: restoredJournal }).snapshot('automatic');
    assert.equal(restored.metadata.title, '竞品分级调研');
    assert.equal(restored.turns.length, 2);
    assert.ok(restored.turns.every(turn => turn.messages.filter(entry => entry.message.role === 'assistant')
      .every(entry => entry.message.content === '普通回复')));
  } finally { restoredJournal.close(); }
});
