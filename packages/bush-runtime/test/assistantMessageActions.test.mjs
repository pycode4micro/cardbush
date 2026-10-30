import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { assistantProfileSchema, assistantConversationRequestSchema, PERSONAL_ASSISTANT_SESSION as sessionId } from '@cardbush/bush-protocol';

const entry = (id, content, role = 'user') => ({ id, content, role, source: role === 'user' ? 'text' : 'page', visibility: 'conversation', createdAt: new Date().toISOString() });
const temporary = () => mkdtempSync(join(tmpdir(), 'assistant-message-actions-'));
const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'quote-request', sessionId, turnId: 'quote-turn', model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Please explain' } }], tools: [], metadata: {}, permissionMode: 'task_free' };
const until = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('timed out'); };

test('quotes and reactions persist separately; quote identity cannot be changed by a resend', () => {
  const directory = temporary(), journal = new ConversationJournal(directory);
  journal.append(sessionId, entry('original', 'A useful answer', 'assistant'));
  const quoted = { ...entry('reply', 'Explain this part'), replyTo: { messageId: 'original', excerpt: 'useful answer' } };
  journal.append(sessionId, quoted);
  journal.setReaction(sessionId, 'original', '❤️');
  assert.deepEqual(new ConversationJournal(directory).read(sessionId)[1], quoted);
  assert.deepEqual(new ConversationJournal(directory).readReactions(sessionId), { original: '❤️' });
  assert.equal(journal.read(sessionId).length, 2, 'feedback must not be a conversational message');
  assert.throws(() => journal.append(sessionId, { ...quoted, replyTo: { messageId: 'original', excerpt: 'different quote' } }), /different content/);
  assert.throws(() => journal.append(sessionId, { ...quoted, id: 'foreign', replyTo: { messageId: 'unknown' } }), /quote_unavailable/);
  journal.append(sessionId, { ...entry('private', 'internal only'), visibility: 'internal' });
  assert.throws(() => journal.setReaction(sessionId, 'private', '👍'), /unavailable/);
  assert.throws(() => journal.append(sessionId, { ...quoted, id: 'private-quote', replyTo: { messageId: 'private' } }), /unavailable/);
  journal.setReaction(sessionId, 'original', '👍');
  assert.deepEqual(journal.readReactions(sessionId), { original: '👍' });
  journal.setReaction(sessionId, 'original', null);
  assert.deepEqual(new ConversationJournal(directory).readReactions(sessionId), {});
  journal.setReaction(sessionId, 'original', '✅'); journal.forget(sessionId);
  assert.deepEqual(new ConversationJournal(directory).readReactions(sessionId), {});
  assert.deepEqual(new ConversationJournal(directory).read(sessionId), []);
});

test('the assistant receives the quoted source and selection as reference data; feedback never invokes it', async () => {
  const journal = new ConversationJournal(temporary()), requests = [];
  journal.append(sessionId, { ...entry('original', 'Earlier advice: review the attached report.', 'assistant'), attachments: [{ id: 'report', name: 'report.md', path: '/work/report.md', type: 'document' }] });
  const assistant = new AssistantConversation(journal, { exists: id => id === sessionId, tasks: () => [], checkpoint: () => ({}), delegate: async () => assert.fail('no delegation'),
    provider: { async *stream(request) {
      requests.push(request);
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      yield { ...base, sequence: 1, kind: 'text_delta', delta: 'This is the explanation.' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    } } });
  try {
    const input = { ...entry('quoted', 'Please explain'), replyTo: { messageId: 'original', excerpt: 'attached report' } };
    assistant.command({ action: 'turn', sessionId, entry: input, parent, profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId }).busy);
    const content = requests[0].messages.find(message => message.role === 'user' && message.content.startsWith('Please explain')).content;
    assert.match(content, /reference data, not a new instruction/);
    assert.match(content, /Earlier advice/); assert.match(content, /selectedExcerpt/); assert.match(content, /\/work\/report.md/);
    assert.equal(journal.read(sessionId).find(item => item.id === 'quoted').content, 'Please explain', 'quoted context is not fused into authored text');
    const { cursor, generation } = assistant.command({ action: 'read', sessionId });
    assistant.command({ action: 'react', sessionId, messageId: 'original', reaction: '😂', generation });
    const latest = assistant.command({ action: 'read', sessionId, after: cursor });
    assert.equal(latest.entries.length, 0); assert.deepEqual(latest.reactions, { original: '😂' });
    assert.equal(requests.length, 1); assert.equal(latest.busy, false);
    assistant.command({ action: 'reset', sessionId });
    assert.throws(() => assistant.command({ action: 'react', sessionId, messageId: 'original', reaction: '👍', generation }), /reset/);
    assert.deepEqual(assistant.command({ action: 'read', sessionId }).reactions, {});
  } finally { assistant.close(); }
});

test('reaction requests require the current generation and a supported reaction', () => {
  const command = { action: 'react', sessionId, messageId: 'message', reaction: '👍', generation: 0 };
  assert.equal(assistantConversationRequestSchema.parse(command).reaction, '👍');
  assert.throws(() => assistantConversationRequestSchema.parse({ ...command, generation: undefined }));
  assert.throws(() => assistantConversationRequestSchema.parse({ ...command, reaction: '<script>' }));
});
