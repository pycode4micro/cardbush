// Run once per runtime build, using the same synthetic journal and blind question.
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { createModelProvider } from '@cardbush/bush-provider-openai';
import { unprotectConfiguration } from '@cardbush/platform/credentials';
import { PERSONAL_ASSISTANT_SESSION as id, assistantProfileSchema } from '@cardbush/bush-protocol';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, runtime: { type: 'string' }, output: { type: 'string' },
  scenario: { type: 'string', default: 'receipts' } } });
assert.ok(values.live && values.output, 'Use --live --output <new report.json> [--runtime <built runtime directory>].');
assert.ok(['receipts', 'narrative'].includes(values.scenario));
const load = name => import(pathToFileURL(resolve(values.runtime ?? 'packages/bush-runtime/dist', name + '.js')).href);
const { ConversationJournal } = await load('conversationJournal');
const { AssistantContextMaintenance } = await load('assistantContextMaintenance');
const { registerContextCompactionTool } = await load('contextCompaction');
const { ToolRegistry } = await load('toolRegistry');
const { AssistantConversation } = await load('assistantConversation');
const config = unprotectConfiguration(JSON.parse(await readFile(join(process.env.APPDATA, 'cardbush/product-host/config/models.json'), 'utf8')));
const model = config.models.find(item => item.id === config.defaultModelId);
assert.ok(model?.apiKey);
const provider = createModelProvider({ adapter: model.apiProtocol, apiKey: model.apiKey, baseURL: model.baseURL || model.baseUrl,
  defaultHeaders: model.defaultHeaders, timeoutMs: 120000 });
const report = { model: model.model, scenario: values.scenario, calls: [], facts: {} };
let phase = 'idle';
const observed = { async *stream(request, options) {
  const row = { phase, ms: 0 }; report.calls.push(row);
  assert.ok(report.calls.length <= 12, 'Maximum live requests exceeded');
  const started = performance.now();
  try {
    for await (const event of provider.stream(request, options)) {
      if (event.kind === 'usage') Object.assign(row, { inputTokens: event.inputTokens, outputTokens: event.outputTokens });
      yield event;
    }
  } finally { row.ms = Math.round(performance.now() - started); }
} };
const output = await open(values.output, 'wx');
const root = await mkdtemp(join(tmpdir(), 'assistant-retention-'));
const journal = new ConversationJournal(root), history = journal.modelHistory(id);
const registry = new ToolRegistry();
registerContextCompactionTool(registry, () => assert.fail('Unexpected dispatch'));
const checkpoint = () => registry.definitions().find(t => t.name === 'checkpoint_context');
const maintenance = new AssistantContextMaintenance();
const assistant = new AssistantConversation(journal, { provider: observed, exists: () => true,
  tasks: () => [], checkpoint, delegate: async () => assert.fail('No delegated work in this fixture') });
try {
  const parent = { protocol: 'bush.session_turn_request.v1', sessionId: id, turnId: 'audit', requestId: 'audit',
    model: model.model, inputMessages: [], prefixMessages: [], permissionMode: 'task_free', tools: [],
    maxOutputTokens: 2048, metadata: { contextWindowTokens: 32000 } };
  const question = 'Using the conversation evidence already in context, answer without tools. Return one JSON object with string fields account, release_permission, cancelled_job, running_job, audio_error and subtitle_revision. Give the exact recorded values or UNKNOWN.';
  parent.inputMessages.push({ messageId: 'audit', message: { role: 'user', content: question } });
  const inputs = ['Account MOSS-14. Release permission GRANTED.', 'Correction: account LIME-39. Release permission REVOKED.',
    'Keep subtitle revision SUB-72.', ...Array(11).fill('Continue observing the batch.')];
  for (const [i, content] of inputs.entries()) {
    const fact = [{ status: 'cancelled', job_id: 'job-Q981' }, { status: 'running', job_id: 'job-A326' },
      { status: 'failed', error: 'AUDIO_E17' }][i] ?? { status: 'ok', batch: i };
    const callId = 'probe-' + i;
    const log = i === 2 ? 'audio check' : 'heartbeat ok. '.repeat(900);
    history.append([{ role: 'user', content }, { role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'tasks', argumentsText: '{"action":"inspect"}' }] },
      { role: 'tool', toolCallId: callId, content: JSON.stringify(values.scenario === 'receipts' ? { ...fact, log } : fact) },
      { role: 'assistant', content: values.scenario === 'receipts' ? 'Observation recorded.' : log, toolCalls: [] }]);
  }
  const t = performance.now();
  await maintenance.compact(history, parent, observed, checkpoint(), AbortSignal.timeout(240000), []);
  report.idleMs = Math.round(performance.now() - t);
  phase = 'followup';
  const start = performance.now();
  await assistant.command({ action: 'turn', sessionId: id, parent, profile: assistantProfileSchema.parse({}),
    entry: { id: 'audit', source: 'text', role: 'user', visibility: 'conversation', content: question, createdAt: new Date().toISOString() } });
  for (;;) {
    const state = await assistant.command({ action: 'read', sessionId: id });
    if (state.error) throw Error('Audit failed: ' + state.error);
    if (!state.busy) break;
    assert.ok(performance.now() - start < 150000, 'Audit timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  report.followupMs = Math.round(performance.now() - start);
  report.answer = journal.read(id).filter(m => m.role === 'assistant').at(-1)?.content;
  const expected = { account: 'LIME-39', release_permission: 'REVOKED', cancelled_job: 'job-Q981',
    running_job: 'job-A326', audio_error: 'AUDIO_E17', subtitle_revision: 'SUB-72' };
  let answer = {};
  try { answer = JSON.parse((report.answer ?? '').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, '')); } catch { /* Invalid JSON earns no checks. */ }
  for (const [field, value] of Object.entries(expected)) report.facts[field] = answer?.[field] === value;
} catch (error) {
  report.failure = { phase, code: typeof error?.code === 'string' ? error.code : error?.name };
  throw error;
} finally {
  assistant.close(); maintenance.cancel(); await rm(root, { recursive: true, force: true });
  try { await output.writeFile(JSON.stringify(report, null, 2)); } finally { await output.close(); }
  console.log(JSON.stringify(report));
}
