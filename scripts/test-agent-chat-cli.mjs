import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalScreen } from './helpers/agent-chat-terminal-screen.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { followAgentTurn, recoverAgentObservation, stopAgentTurn, resumeHint, terminalText } from '../dist-electron/agentChatCli.mjs';
import { NativeChatTerminal } from '../dist-electron/agentChatTerminal.mjs';
import { AgentHttpClient, AgentHttpError, AgentNetworkError } from '../dist-electron/agentHttpClient.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { localDesktopProfile, openLocalChatClient } from '../dist-electron/agentLocalChat.mjs';
import { chatShellCommand, chatShellInvocation, runChatShell } from '../dist-electron/agentChatShell.mjs';
import { waitForChatConfiguration, selectChatModel, chatEffortLabel } from '../dist-electron/agentChatModels.mjs';
import { inspectChatTools } from '../dist-electron/agentChatTools.mjs';
import { optionalResumeArgs, readChatHistory, selectChatSession } from '../dist-electron/agentChatSessions.mjs';

// Native readline reads TERM from process.env as well as the emulated TTY.
process.env.TERM = 'xterm';

const entry = resolve('dist-electron/agentChatCli.mjs');
const tempRoot = resolve('tmp/agent-chat-cli-tests');
const job = { id: 'job', sessionId: 'session', turnId: 'turn' };
const segment = { messageId: 'message', segmentId: 'segment', ordinal: 0 };
const localChildren = new Map();
const localClients = new Map();
async function localClient(env) {
  const client = await openLocalChatClient({ dataRoot: env.CARDBUSH_CLI_DATA_DIR, profileRoot: env.CARDBUSH_CLI_PROFILE_DIR });
  localClients.set(client, env.CARDBUSH_CLI_DATA_DIR); return client;
}
async function localStopped(dataRoot) {
  await until(() => readFile(join(dataRoot, 'agent.lock'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    if (process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code)) return 'closing';
    throw error;
  }), value => value === null);
}

const pickerConfig = { defaultModelId: 'responses', models: [
  { id: 'responses', modelName: 'Response Model', apiProtocol: 'openai_responses', reasoningEffort: 'high' },
  { id: 'chat', modelName: 'Chat Model', apiProtocol: 'openai_chat_completions', reasoningEffort: 'max' },
  { id: 'anthropic', modelName: 'Messages Model', apiProtocol: 'anthropic_messages', reasoningEffort: null },
] };
async function pickModel(answers, current = { modelId: 'responses' }, argument = '') {
  const prompts = [], output = [];
  const result = await selectChatModel(pickerConfig, current, argument, {
    interactive: true, status(text) { output.push(text); },
    async ask(prompt, signal, options) {
      assert.ok(answers.length, `Unexpected extra prompt: ${prompt}`);
      prompts.push({ prompt, options }); signal.throwIfAborted(); return answers.shift();
    },
  }, new AbortController().signal);
  assert.equal(answers.length, 0);
  return { result, prompts, output: output.join('') };
}

test('model picker selects effort using the shared App protocol rules and preserves defaults', async () => {
  const picked = await pickModel(['3', 'max']);
  assert.deepEqual(picked.result, { modelId: 'anthropic', reasoningEffort: 'max' });
  assert.deepEqual(picked.prompts[1].options.choices.map(item => item.value), ['configured', 'default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.match(picked.output, /Effort: Max/);
  const limited = await pickModel(['2', 'max', 'high']);
  assert.deepEqual(limited.result, { modelId: 'chat', reasoningEffort: 'high' });
  assert.deepEqual(limited.prompts[1].options.choices.map(item => item.value), ['configured', 'default', 'low', 'medium', 'high']);
  assert.match(limited.output, /Choose an effort from the list/);
  assert.match(limited.prompts[1].options.choices[0].description, /High/);
  assert.equal(chatEffortLabel(pickerConfig.models[1]), 'High');
  assert.deepEqual(pickerConfig.models.map(model => model.reasoningEffort), ['high', 'max', null], 'selection never mutates shared configuration');
});

test('provider default clears effort while model setting inherits it; empty Enter keeps the highlighted value', async () => {
  assert.deepEqual((await pickModel(['', ''])).result, { modelId: 'responses' });
  assert.deepEqual((await pickModel(['default'], { modelId: 'responses', reasoningEffort: 'low' }, 'responses')).result,
    { modelId: 'responses', reasoningEffort: null });
  const picked = await pickModel([''], { modelId: 'chat', reasoningEffort: 'max' }, 'chat');
  assert.equal(picked.prompts[0].options.picker.selected, 'high', 'stored efforts use the App protocol mapping');
  assert.deepEqual(picked.result, { modelId: 'chat', reasoningEffort: 'high' });
  assert.equal(chatEffortLabel(pickerConfig.models[0], null), 'Provider default');
  assert.equal(chatEffortLabel(pickerConfig.models[0]), 'High');
});

test('back or cancellation never commits a partially chosen model or effort', async () => {
  const current = { modelId: 'responses', reasoningEffort: 'low' };
  for (const answers of [['/cancel'], ['2', '/cancel'], ['2', null], ['2', '/back', '/cancel']]) {
    assert.equal((await pickModel(answers, current)).result, current);
  }
  const back = await pickModel(['2', '/back', '3', 'configured'], current);
  assert.equal(back.prompts[2].options.picker.selected, 'chat');
  assert.equal(back.prompts[1].options.picker.cancelValue, '/back');
  assert.deepEqual(back.result, { modelId: 'anthropic' });
  assert.equal((await pickModel([], current, 'missing-model')).result, current);
});
const permission = { permissionId: 'permission', reason: 'Read outside workspace', actions: ['file.read'],
  targets: [{ kind: 'filesystem_path', value: '/outside.txt' }], requestedCapabilityIds: ['file.read.outside'] };
const question = { selectionId: 'selection', sessionId: job.sessionId, turnId: job.turnId, toolCallId: 'tool',
  createdAt: new Date().toISOString(), prompt: 'Which scope?', options: ['First', 'Second'], blocking: true };
const event = (kind, sequence, payload) => ({ type: 'event', event: { protocol: 'bush.runtime_event.v1',
  eventId: `event-${sequence}`, sequence, requestId: 'request', sessionId: job.sessionId, turnId: job.turnId,
  createdAt: new Date().toISOString(), kind, payload } });

function terminal(answer = 'y', interactive = true) {
  return { interactive, output: '', progress: '', questions: [], write(text) { this.output += text; },
    status(text) { this.progress += text; }, async ask(prompt) { this.questions.push(prompt); return answer; } };
}

function nativeTerminal(t, live = false, columns = 120) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  let progress = '', interrupts = 0;
  const output = Object.assign(new Writable({ write(data, _encoding, done) { progress += data.toString(); done(); } }),
    { isTTY: true, columns, rows: 30 });
  const io = new NativeChatTerminal(() => { interrupts++; }, { input, output, status: output, env: { TERM: 'xterm', NO_COLOR: '' } });
  t.after(() => io.close());
  if (live) { io.enableLiveInput(() => assert.fail('An interaction must not submit chat')); io.beginTurn(); }
  return { io, input, get progress() { return stripVTControlCharacters(progress); }, get interrupts() { return interrupts; } };
}

test('tool inspection rereads the selected turn without running tools or exposing diagnostics by default', async () => {
  const tool = { toolCallId: 'read', toolName: 'read_file', ordinal: 0, display: { title: 'Read design guidance' } };
  const frames = [
    event('tool_queued', 1, tool), event('tool_running', 2, tool),
    event('tool_returned', 3, { ...tool, resultError: { kind: 'tool', code: 'file_missing',
      message: 'Full diagnostic: selected guidance file does not exist.', details: { path: '/fixture/guidance.md' } } }),
    event('tool_running', 4, { toolCallId: 'check', toolName: 'terminal_exec', ordinal: 1, display: { title: 'Check existing files' } }),
    event('tool_cancelled', 5, { toolCallId: 'cancelled', toolName: 'terminal_exec', ordinal: 2, reason: 'Stopped by user', display: { title: 'Run validation' } }),
  ].map(frame => frame.event);
  const calls = [], client = { async call(method, input) {
    calls.push({ method, input });
    if (input.kind === 'runtime.get_tool_execution') return { sessionId: job.sessionId, turnId: job.turnId,
      toolCall: { id: input.payload.toolCallId, argumentsText: '{"path":"/fixture/guidance.md"}' }, result: 'execution receipt' };
    return [...frames, { ...frames[0], turnId: 'another-turn', payload: { ...tool, toolCallId: 'foreign', display: { title: 'Unrelated work' } } }];
  } }, io = terminal(), signal = new AbortController().signal;
  await inspectChatTools(client, io, job, '', signal);
  assert.match(io.progress, /1\. Read design guidance · Failed/);
  assert.match(io.progress, /2\. Check existing files · Running/);
  assert.match(io.progress, /3\. Run validation · Cancelled/);
  assert.doesNotMatch(io.progress, /Full diagnostic|Unrelated work|\/fixture/);
  io.progress = '';
  await inspectChatTools(client, io, job, '1', signal);
  assert.match(io.progress, /file_missing: Full diagnostic: selected guidance file does not exist\./);
  assert.match(io.progress, /\/fixture\/guidance\.md/);
  assert.match(io.progress, /Arguments:[\s\S]*Result:\nexecution receipt/);
  io.progress = ''; await inspectChatTools(client, io, job, '3', signal);
  assert.match(io.progress, /Cancellation: Stopped by user/);
  assert.ok(calls.every(call => call.method === 'runtime.command' && ['runtime.list_turn_events', 'runtime.get_tool_execution'].includes(call.input.kind)));
  assert.equal(io.output, '');
  const before = calls.length;
  io.progress = ''; await inspectChatTools(client, io, job, 'invalid', signal);
  assert.match(io.progress, /Usage: \/tools/); assert.equal(calls.length, before);
});
function clientFixture(frames, { pending = true, status = 'completed' } = {}) {
  return { calls: [], cursors: [], open: false,
    async *events(input) {
      this.cursors.push(input.afterSequence); this.open = true;
      try { for (const frame of frames) if (frame.event.sequence > (input.afterSequence ?? 0)) yield frame;
        yield { type: 'end' };
      } finally { this.open = false; }
    },
    async call(operation, input) {
      this.calls.push({ operation, input });
      if (operation === 'chat.jobs') return [{ ...job, status: pending && status === 'completed' && frames.some(frame => ['permission_requested', 'solution_selection_requested'].includes(frame.event.kind)) ? 'running' : status, error: status === 'failed' ? 'Fixture task failed' : undefined }];
      if (operation === 'chat.stop') return { accepted: true };
      if (input.kind === 'runtime.list_turn_events') return frames.map(frame => frame.event).filter(item => item.sequence > input.payload.afterSequence);
      if (input.kind === 'runtime.list_solution_selections') return pending ? [question] : [];
      if (input.kind === 'runtime.answer_permission' || input.kind === 'runtime.answer_solution_selection') { pending = false; return { accepted: true }; }
      assert.fail(`Unexpected operation: ${operation} ${input.kind}`);
    },
  };
}

test('terminal output is plain data, not terminal escape commands', () => {
  assert.equal(terminalText('\x1b[2Jhello\r\n\x1b]52;c;YWJj\x07world\x00\b\t!'), 'hello\nworld\t!');
  assert.equal(resumeHint('session-123', true), '\nResume this session: cardbush --resume \x1b[34msession-123\x1b[0m\n');
  assert.equal(resumeHint('\x1b[2Jsession-123', false), '\nResume this session: cardbush --resume session-123\n');
});

test('optional resume parsing leaves prompt data and other option values intact', () => {
  assert.deepEqual(optionalResumeArgs(['--resume', '--local']), { args: ['--resume=', '--local'], picker: true });
  assert.deepEqual(optionalResumeArgs(['--resume', 's']), { args: ['--resume', 's'], picker: false });
  assert.deepEqual(optionalResumeArgs(['--prompt', '--resume']), { args: ['--prompt', '--resume'], picker: false });
  assert.equal(optionalResumeArgs(['--prompt=--resume']).picker, false);
  assert.equal(optionalResumeArgs(['--', '--resume']).picker, false);
  assert.equal(optionalResumeArgs(['--resume', '']).picker, false);
});

test('session selection reads summaries only, sanitizes labels and cancels without creating a session', async () => {
  const calls = [], sessions = [{ sessionId: 'older', updatedAt: '2025', metadata: { title: 'Older' } },
    { sessionId: 'newer', updatedAt: '2026', metadata: { title: '\x1b[2JNewer' } }];
  const client = { async call(...args) { calls.push(args); return sessions; } }, signal = new AbortController().signal;
  const io = terminal('1');
  assert.equal((await selectChatSession(client, io, signal)).sessionId, 'newer');
  assert.doesNotMatch(io.progress, /\x1b/);
  assert.equal((await selectChatSession(client, io, signal, 'older')).sessionId, 'older');
  assert.equal(await selectChatSession(client, terminal('/cancel'), signal), undefined);
  assert.equal(await selectChatSession(client, io, signal, 'missing'), undefined);
  assert.ok(calls.every(([method, input]) => method === 'sessions.list' && input.projection === 'summary'));
});

test('session picker uses local minute timestamps and only prints a list without selection menus', async () => {
  const sessions = [
    { sessionId: 'dated', updatedAt: new Date(2026, 9, 25, 0, 5, 59).toISOString(),
      metadata: { title: '\x1b[2J项目会话', projectDir: 'D:\\other-project\x1b[2J' } },
    { sessionId: 'invalid', updatedAt: 'not-a-date', metadata: { title: 'Invalid timestamp' } },
    { sessionId: 'undated', metadata: { title: 'Missing timestamp' } },
  ];
  const client = { async call() { return sessions; } }, signal = AbortSignal.timeout(2000);
  const io = terminal('/cancel'); io.selectionMenus = true;
  let choices;
  io.ask = async (_prompt, _signal, options) => { choices = options.choices; return '/cancel'; };
  assert.equal(await selectChatSession(client, io, signal, '', 'dated'), undefined);
  assert.equal(io.progress, '', 'the interactive picker must not be preceded by a static duplicate');
  const dated = choices.find(item => item.value === 'dated');
  assert.match(dated.label, /项目会话 · current$/);
  assert.equal(dated.description, '2026-10-25 00:05 · D:\\other-project · dated');
  assert.doesNotMatch(JSON.stringify(choices), /\\u001b|Invalid Date|NaN/);
  for (const id of ['invalid', 'undated']) assert.match(choices.find(item => item.value === id).description, /^Unknown time · /);
  const plain = terminal('dated'); plain.selectionMenus = false;
  assert.equal((await selectChatSession(client, plain, signal)).sessionId, 'dated');
  assert.equal(plain.progress.split('Sessions · most recent first').length - 1, 1);
  assert.match(plain.progress, /2026-10-25 00:05 · D:\\other-project · dated/);
  assert.match(plain.progress, /Enter a number or session ID/);
});

test('native session picker shows dates before long IDs and does not leave a static list above the prompt', async t => {
  const session = { sessionId: 'session-d8b15e73-fffc-4fea-adda-65a7fac2cb92',
    updatedAt: new Date(2026, 9, 25, 9, 19).toISOString(),
    metadata: { title: '帮我做一个很长很长的中文标题用于验证会话列表的日期不会被截断', projectDir: 'D:\\proj\\bushserver' } };
  const client = { async call() { return [session]; } };
  for (const columns of [64, 80, 120]) {
    const f = nativeTerminal(t, false, columns);
    const selection = selectChatSession(client, f.io, AbortSignal.timeout(2000));
    await until(() => f.progress, text => text.includes('Sessions · most recent first'));
    assert.doesNotMatch(f.progress.split('Select a session:')[0], /Sessions|bushserver|很长/);
    assert.match(f.progress, /1\. 帮我[^\r\n]*2026-10-25 09:19/);
    f.input.write('\r');
    assert.equal((await selection)?.sessionId, session.sessionId);
    f.io.close();
  }
});

test('native session picker opens the highlighted session with Enter and cancels with Escape', async t => {
  const sessions = [{ sessionId: 'older', updatedAt: '2025', metadata: { title: 'Older' } },
    { sessionId: 'newer', updatedAt: '2026', metadata: { title: 'Newer' } }];
  const client = { async call() { return sessions; } };
  for (const [current, keys, expected] of [[undefined, '\r', 'newer'], [undefined, '\x1b[B\r', 'older'],
    ['older', '\r', 'older'], ['older', '\x1b[A\r', 'newer'], ['older', '\x1b', undefined]]) {
    const f = nativeTerminal(t);
    const selection = selectChatSession(client, f.io, AbortSignal.timeout(2000), '', current);
    await until(() => f.progress, text => text.includes('Select a session:'));
    f.input.write(keys);
    assert.equal((await selection)?.sessionId, expected);
    assert.equal(f.interrupts, 0);
    f.io.close();
  }
});

test('Ctrl+C follows this CLI\'s running successor and waits for durable stop without cancelling the remaining queue', async () => {
  const observed = { ...job, status: 'completed' };
  const next = { ...job, id: 'next', turnId: 'next-turn', status: 'running' };
  const queued = { ...job, id: 'later', turnId: 'later-turn', status: 'queued' };
  const foreign = { ...next, id: 'foreign', sessionId: 'another-session' };
  const calls = []; let reads = 0, resolved = false;
  const client = { async call(operation, input) {
    calls.push({ operation, input });
    if (operation === 'chat.jobs') { reads++; return [foreign, observed, next, queued]; }
    assert.equal(operation, 'chat.stop'); assert.equal(input.id, next.id);
    return { accepted: true };
  } };
  const stop = stopAgentTurn(client, job, terminal(), new Set(['next', 'later', 'foreign'])).then(result => { resolved = true; return result; });
  await until(() => reads, count => count >= 2);
  assert.equal(resolved, false, 'accepting a stop request is not a stopped task');
  next.status = 'stopped'; queued.status = 'running';
  assert.equal((await stop).status, 'completed', 'the preceding completed turn keeps its actual outcome');
  assert.deepEqual(calls.filter(call => call.operation === 'chat.stop'), [{ operation: 'chat.stop', input: { id: 'next' } }]);
});

for (const status of ['queued', 'running']) test(`Ctrl+C stops and confirms its ${status} task once`, async () => {
  const state = { ...job, status }, requests = [];
  const client = { async call(operation, input) {
    if (operation === 'chat.jobs') return [state];
    requests.push(input.id); state.status = 'stopped'; return { accepted: true };
  } };
  assert.equal((await stopAgentTurn(client, job, terminal())).status, 'stopped');
  assert.deepEqual(requests, [job.id]);
});

for (const status of ['completed', 'failed', 'stopped']) test(`Ctrl+C preserves an already ${status} task and leaves another client's job alone`, async () => {
  const client = { async call(operation) {
    assert.equal(operation, 'chat.jobs');
    return [{ ...job, status }, { ...job, id: 'another-client', status: 'running' }];
  } };
  assert.equal((await stopAgentTurn(client, job, terminal())).status, status);
});

for (const failure of ['rejected', 'disconnected', 'missing', 'timeout']) test(`Ctrl+C reports an unconfirmed stop after ${failure}`, async t => {
  const abort = new AbortController();
  if (failure === 'timeout') t.mock.method(AbortSignal, 'timeout', () => abort.signal);
  let requested = false;
  const client = { async call(operation) {
    if (operation === 'chat.jobs') {
      if (requested && failure === 'missing') return [];
      if (requested && failure === 'timeout') abort.abort(new DOMException('Timed out', 'TimeoutError'));
      return [{ ...job, status: 'running' }];
    }
    assert.equal(operation, 'chat.stop'); requested = true;
    if (failure === 'disconnected') throw new AgentNetworkError('disconnected');
    return { accepted: failure !== 'rejected' };
  } };
  await assert.rejects(stopAgentTurn(client, job, terminal()), /Stop could not be confirmed.*Resume session session/);
});

test('stream reconnect uses the cursor, preserves partial text and never resubmits', async () => {
  const client = clientFixture([]), io = terminal();
  client.events = async function* (input) {
    this.cursors.push(input.afterSequence);
    if (this.cursors.length === 1) {
      yield event('assistant_segment_delta', 1, { ...segment, delta: 'hel' });
      throw new AgentNetworkError('connection lost');
    }
    yield event('assistant_segment_completed', 2, { ...segment, content: 'hello' });
    yield { type: 'end' };
  };
  assert.equal(await followAgentTurn(client, job, io, new AbortController().signal), 0);
  assert.deepEqual(client.cursors, [undefined, 1]); assert.equal(io.output, 'hello\n');
  assert.ok(client.calls.every(call => call.operation !== 'chat.send'));
});

test('CLI preserves message identities and corrected final text while ignoring duplicate or foreign events', async () => {
  const foreign = event('assistant_segment_delta', 99, { ...segment, delta: 'FOREIGN' }); foreign.event.sessionId = 'other-session';
  const first = event('assistant_segment_delta', 1, { ...segment, delta: '草稿' });
  const frames = [foreign, first, first, event('assistant_segment_completed', 2, { ...segment, content: '正式回复' }),
    event('assistant_segment_delta', 3, { ...segment, messageId: 'second-message', delta: '另一个段落' }),
    event('assistant_segment_completed', 4, { ...segment, messageId: 'second-message', content: '另一个段落' })];
  const client = clientFixture(frames), io = terminal();
  assert.equal(await followAgentTurn(client, job, io, new AbortController().signal), 0);
  assert.equal(io.output, '草稿\n正式回复\n另一个段落\n'); assert.match(io.progress, /Response revised/);
  assert.doesNotMatch(io.progress, /\p{Script=Han}/u, 'CLI status language is independent of model output');
  assert.ok(client.calls.every(call => call.operation !== 'chat.send'));
});

test('reconnect is bounded and a failed durable job is not reported as success', async () => {
  const client = clientFixture([]); let attempts = 0;
  client.events = async function* () { attempts++; throw new AgentNetworkError('offline'); };
  await assert.rejects(followAgentTurn(client, job, terminal(), new AbortController().signal), /offline/);
  assert.equal(attempts, 4);
  await assert.rejects(followAgentTurn(clientFixture([], { status: 'failed' }), job, terminal(), new AbortController().signal), /Fixture task failed/);
  assert.equal(await followAgentTurn(clientFixture([], { status: 'stopped' }), job, terminal(), new AbortController().signal), 130);
});

test('stream end waits for durable job completion instead of misreporting running as failure', async () => {
  const client = clientFixture([]); let reads = 0;
  client.call = async operation => { assert.equal(operation, 'chat.jobs'); return [{ ...job, status: ++reads === 1 ? 'running' : 'completed' }]; };
  assert.equal(await followAgentTurn(client, job, terminal(), new AbortController().signal), 0); assert.equal(reads, 2);
});

for (const answer of ['y', 'no']) test(`approval ${answer}: stream closes before native input; only requested capabilities are granted`, async () => {
  const client = clientFixture([event('permission_requested', 1, permission)]), io = terminal(answer);
  io.ask = async () => { assert.equal(client.open, false); return answer; };
  await followAgentTurn(client, job, io, new AbortController().signal);
  const reply = client.calls.find(call => call.input.kind === 'runtime.answer_permission').input.payload;
  assert.equal(reply.permissionId, permission.permissionId);
  assert.equal(reply.decision, answer === 'y' ? 'allow_once' : 'deny');
  assert.deepEqual(reply.grantedCapabilityIds, answer === 'y' ? permission.requestedCapabilityIds : []);
});

test('native approval sends the selected decision to Runtime on Enter, including during a live turn', async t => {
  for (const live of [false, true]) for (const [keys, decision] of [
    ['\x1b[B\r', 'allow_once'], ['\r', 'deny'], ['\x1b[A\r', 'allow_once'],
    ['\x1b[B\x1b[A\r', 'deny'], ['y\r', 'allow_once'], ['n\r', 'deny'], ['\x1b[B\x1b', 'deny'],
    ['n\x7f\x1b[B\r', 'allow_once'],
  ]) {
    const f = nativeTerminal(t, live), client = clientFixture([event('permission_requested', 1, permission)]);
    const follow = followAgentTurn(client, job, f.io, AbortSignal.timeout(2000));
    await until(() => f.progress, text => text.includes('Allow once?'));
    assert.equal(client.open, false, 'stream releases input before asking');
    f.input.write(keys);
    assert.equal(await follow, 0);
    const replies = client.calls.filter(call => call.input.kind === 'runtime.answer_permission');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].input.payload.permissionId, permission.permissionId);
    assert.equal(replies[0].input.payload.decision, decision, `live=${live}, keys=${JSON.stringify(keys)}`);
    assert.deepEqual(replies[0].input.payload.grantedCapabilityIds, decision === 'allow_once' ? permission.requestedCapabilityIds : []);
    assert.equal(f.interrupts, 0, 'Escape answers the approval without stopping the turn');
    assert.doesNotMatch(f.progress, /Type y to allow|anything else to deny/);
    f.io.close();
  }
});

test('native question picker submits the visible option or free text and Escape cancels', async t => {
  for (const [keys, expected] of [['\r', { kind: 'option', optionIndex: 0 }],
    ['\x1b[B\r', { kind: 'option', optionIndex: 1 }], ['Custom answer\r', { kind: 'text', text: 'Custom answer' }],
    ['\x1b', { kind: 'cancel' }]]) {
    const f = nativeTerminal(t, true), client = clientFixture([event('solution_selection_requested', 1, question)]);
    const follow = followAgentTurn(client, job, f.io, AbortSignal.timeout(2000));
    await until(() => f.progress, text => /Answer \(or type your own\):|Enter a number/.test(text));
    f.input.write(keys);
    assert.equal(await follow, 0);
    const replies = client.calls.filter(call => call.input.kind === 'runtime.answer_solution_selection');
    assert.deepEqual(replies.map(call => call.input.payload), [{ sessionId: job.sessionId, turnId: job.turnId,
      selectionId: question.selectionId, ...expected }]);
    assert.equal(f.interrupts, 0);
    f.io.close();
  }
});

test('answered approvals and resolved questions are skipped on replay', async () => {
  const client = clientFixture([
    event('permission_requested', 1, permission),
    event('permission_answered', 2, { permissionId: permission.permissionId, answerId: 'answered', decision: 'deny', grantedCapabilityIds: [] }),
    event('solution_selection_requested', 3, question),
  ], { pending: false }), io = terminal();
  await followAgentTurn(client, job, io, new AbortController().signal);
  assert.deepEqual(io.questions, []); assert.ok(client.calls.every(call => !call.input.kind?.startsWith('runtime.answer')));
});

for (const kind of ['permission_requested', 'solution_selection_requested']) test(`withdrawn ${kind} closes a native prompt without input or stopping the task`, { timeout: 6000 }, async t => {
  const payload = kind === 'permission_requested' ? permission : question;
  const frames = [event(kind, 1, payload)], client = clientFixture(frames), f = nativeTerminal(t, true);
  const original = client.call.bind(client); let withdrawn = false;
  client.call = async (operation, input) => {
    if (operation === 'chat.jobs' && withdrawn) return [{ ...job, status: 'completed' }];
    if (input.kind === 'runtime.list_solution_selections' && withdrawn) return [];
    return original(operation, input);
  };
  const follow = followAgentTurn(client, job, f.io, AbortSignal.timeout(5000));
  await until(() => f.progress, text => /Allow once\?|Answer \(or type your own\)/.test(text));
  withdrawn = true;
  frames.push(event(kind === 'permission_requested' ? 'permission_cancelled' : 'solution_selection_cancelled', 2,
    kind === 'permission_requested' ? { permissionId: permission.permissionId, reason: 'cancelled' }
      : { selectionId: question.selectionId, reason: 'cancelled' }));
  assert.equal(await follow, 0);
  await until(() => f.progress, text => text.includes('request has ended'));
  assert.equal(f.interrupts, 0);
  assert.ok(client.calls.every(call => call.operation !== 'chat.stop' && !call.input.kind?.startsWith('runtime.answer')));
});

for (const legacy of [false, true]) test(`an approval lost to another client after validation continues the original task (legacy=${legacy})`, async () => {
  const client = clientFixture([event('permission_requested', 1, permission)]), original = client.call.bind(client), io = terminal();
  client.call = async (operation, input) => {
    const result = await original(operation, input);
    if (input.kind === 'runtime.answer_permission') throw new AgentHttpError(`Permission ${permission.permissionId} is not pending.`, 409, legacy ? 'operation_failed' : 'permission_not_pending');
    return result;
  };
  assert.equal(await followAgentTurn(client, job, io, new AbortController().signal), 0);
  assert.match(io.progress, /request has ended/);
  assert.equal(client.calls.filter(call => call.input.kind === 'runtime.answer_permission').length, 1);
  assert.ok(client.calls.every(call => !['chat.send', 'chat.stop'].includes(call.operation)));
});

test('lost approval acknowledgement reconciles the recorded decision without submitting it twice', async () => {
  const frames = [event('permission_requested', 1, permission)], client = clientFixture(frames), original = client.call.bind(client);
  client.call = async (operation, input) => {
    const result = await original(operation, input);
    if (input.kind === 'runtime.answer_permission') {
      frames.push(event('permission_answered', 2, { permissionId: permission.permissionId, answerId: 'committed', grantedCapabilityIds: permission.requestedCapabilityIds }));
      throw new AgentNetworkError('acknowledgement lost');
    }
    return result;
  };
  assert.equal(await followAgentTurn(client, job, terminal(), new AbortController().signal), 0);
  assert.equal(client.calls.filter(call => call.input.kind === 'runtime.answer_permission').length, 1);
});

test('replay skips approvals of a durably failed task even without a permission cancellation event', async () => {
  const client = clientFixture([event('permission_requested', 1, permission)], { status: 'failed' }), io = terminal();
  await assert.rejects(followAgentTurn(client, job, io, new AbortController().signal), /Fixture task failed/);
  assert.deepEqual(io.questions, []);
  assert.ok(client.calls.every(call => !call.input.kind?.startsWith('runtime.answer')));
});

test('incident replay: skip the expired script approval and answer the newer pending request without resubmitting', async () => {
  // Sanitized ordering from session-0e9d7ef4: a new request arrived while the
  // CLI was still displaying the script request, then the script was cancelled.
  const newer = { ...permission, permissionId: 'newer-permission' };
  const client = clientFixture([
    event('permission_requested', 13249, permission),
    event('permission_requested', 13997, newer),
    event('permission_cancelled', 13998, { permissionId: permission.permissionId, reason: 'turn_cancelled' }),
  ]), io = terminal();
  assert.equal(await followAgentTurn(client, job, io, new AbortController().signal), 0);
  assert.equal(io.questions.length, 1);
  assert.deepEqual(client.calls.filter(call => call.input.kind === 'runtime.answer_permission').map(call => call.input.payload.permissionId), ['newer-permission']);
  assert.ok(client.calls.every(call => !['chat.send', 'chat.stop'].includes(call.operation)));
});

test('unrelated approval errors stay visible and reconnect retains the unresolved interaction', async () => {
  const client = clientFixture([event('permission_requested', 1, permission)]), original = client.call.bind(client), observation = {};
  let fail = true;
  client.call = async (operation, input) => {
    if (fail && input.kind === 'runtime.answer_permission') throw new AgentHttpError('Capability mismatch', 409, 'operation_failed');
    return original(operation, input);
  };
  await assert.rejects(followAgentTurn(client, job, terminal(), new AbortController().signal, observation), /Capability mismatch/);
  assert.equal(observation.interaction.payload.permissionId, permission.permissionId);
  fail = false;
  assert.equal(await followAgentTurn(client, job, terminal(), new AbortController().signal, observation), 0);
  assert.equal(observation.interaction, undefined);
});

test('an observation failure keeps the native terminal open until the user chooses reconnect or exit', { timeout: 5000 }, async t => {
  for (const keys of ['\r', '\x1b[B\r']) {
    const client = clientFixture([], { status: 'running' }), f = nativeTerminal(t, true);
    let settled = false;
    const recovery = recoverAgentObservation(client, job, f.io, new AgentNetworkError('connection lost'), AbortSignal.timeout(4000)).then(value => { settled = true; return value; });
    await until(() => f.progress, text => text.includes('Reconnect to this task?'));
    await delay(40);
    assert.equal(settled, false, 'no automatic process exit or inferred user choice');
    assert.match(f.progress, /still active/); assert.doesNotMatch(f.progress, /Task failed/);
    f.input.write(keys);
    assert.equal(await recovery, keys === '\r' ? 'retry' : 'exit');
    assert.ok(client.calls.every(call => !['chat.send', 'chat.stop'].includes(call.operation)));
    f.io.close();
  }
});

test('reconnecting an observer retains its cursor and does not repeat earlier output', async () => {
  const client = clientFixture([]), observation = {}, io = terminal(); let fail = true;
  client.events = async function* (input) {
    this.cursors.push(input.afterSequence);
    if (fail) { yield event('assistant_segment_delta', 1, { ...segment, delta: 'first' }); throw new Error('observer fault'); }
    yield event('assistant_segment_completed', 2, { ...segment, content: 'first second' }); yield { type: 'end' };
  };
  await assert.rejects(followAgentTurn(client, job, io, new AbortController().signal, observation), /observer fault/);
  fail = false;
  assert.equal(await followAgentTurn(client, job, io, new AbortController().signal, observation), 0);
  assert.deepEqual(client.cursors, [undefined, 1]); assert.equal(io.output, 'first\n second\n');
});

for (const [answer, expected] of [['2', { kind: 'option', optionIndex: 1 }], ['Custom answer', { kind: 'text', text: 'Custom answer' }], ['/cancel', { kind: 'cancel' }]]) {
  test(`terminal question supports ${expected.kind} through the existing protocol`, async () => {
    const client = clientFixture([event('solution_selection_requested', 1, question)]);
    await followAgentTurn(client, job, terminal(answer), new AbortController().signal);
    const reply = client.calls.find(call => call.input.kind === 'runtime.answer_solution_selection').input.payload;
    assert.deepEqual(reply, { sessionId: job.sessionId, turnId: job.turnId, selectionId: question.selectionId, ...expected });
  });
}

for (const kind of ['permission_requested', 'solution_selection_requested']) test(`pipe input cannot approve ${kind}; only its own job is stopped`, async () => {
  const client = clientFixture([event(kind, 1, kind === 'permission_requested' ? permission : question)]);
  await assert.rejects(followAgentTurn(client, job, terminal('', false), new AbortController().signal), { exitCode: 2 });
  assert.deepEqual(client.calls.filter(call => call.operation === 'chat.stop'), [{ operation: 'chat.stop', input: { id: job.id } }]);
  assert.ok(client.calls.every(call => !call.input.kind?.startsWith('runtime.answer')));
});

test('English confirmation prompts preserve model-authored questions and approval reasons', async () => {
  const cases = [
    ['permission_requested', { ...permission, reason: '读取工作区以外的参考文件' }, 'n', 'Approval required: 读取工作区以外的参考文件', 'Allow once?'],
    ['solution_selection_requested', { ...question, prompt: '选择哪个版本？', options: ['当前版本', '新版本'] }, '2', '1. 当前版本\n2. 新版本', 'Enter a number or your own answer'],
  ];
  for (const [kind, payload, answer, displayed, prompt] of cases) {
    const client = clientFixture([event(kind, 1, payload)]), io = terminal(answer);
    await followAgentTurn(client, job, io, new AbortController().signal);
    assert.ok(io.progress.includes(displayed));
    assert.ok(io.questions[0].startsWith(prompt));
    assert.doesNotMatch(io.questions[0], /\p{Script=Han}/u);
  }
});

const multiQuestion = { ...question, prompt: undefined, options: undefined, questions: [
  { id: 'version', prompt: 'Which version?', options: ['Current', 'New'] },
  { id: 'period', prompt: 'Which period?', options: ['This week'] },
] };
for (const mode of ['submit', 'cancel', 'eof', 'abort']) test(`sequential terminal questions ${mode}: no partial reply`, async () => {
  const client = clientFixture([event('solution_selection_requested', 1, multiQuestion)]);
  const controller = new AbortController(), io = terminal(); let index = 0;
  io.ask = async () => {
    assert.equal(client.open, false);
    assert.ok(client.calls.every(call => call.input.kind !== 'runtime.answer_solution_selection'), 'answers stay local until complete');
    if (index++ === 0) return '2';
    if (mode === 'abort') { controller.abort(); return null; }
    return mode === 'submit' ? 'Last month' : mode === 'cancel' ? '/cancel' : null;
  };
  const follow = followAgentTurn(client, job, io, controller.signal);
  if (mode === 'eof') await assert.rejects(follow, { exitCode: 2 });
  else if (mode === 'abort') await assert.rejects(follow, { name: 'AbortError' });
  else await follow;
  assert.match(io.progress, /\[1\/2\] Which version\?/); assert.match(io.progress, /\[2\/2\] Which period\?/);
  const replies = client.calls.filter(call => call.input.kind === 'runtime.answer_solution_selection');
  assert.equal(replies.length, ['eof', 'abort'].includes(mode) ? 0 : 1);
  if (mode === 'submit') assert.deepEqual(replies[0].input.payload, {
    selectionId: question.selectionId, sessionId: job.sessionId, turnId: job.turnId, kind: 'answers',
    answers: [{ questionId: 'version', kind: 'option', optionIndex: 1 }, { questionId: 'period', kind: 'text', text: 'Last month' }],
  });
  if (mode === 'cancel') assert.equal(replies[0].input.payload.kind, 'cancel');
  if (mode === 'eof') assert.equal(client.calls.filter(call => call.operation === 'chat.stop').length, 1);
});

async function until(read, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await delay(20); }
  assert.fail(`Timed out: ${JSON.stringify(value)}`);
}

function cli(t, args, { env = {}, input = '', interactive = false, cwd = resolve('.'), executable = entry } = {}) {
  // Exercise Node's actual readline through pipes with TTY flags; no UI framework
  // or real model. Signals are delivered as native readline key sequences.
  const child = spawn(process.execPath, [interactive ? resolve('scripts/helpers/agent-chat-cli-terminal.mjs') : executable, ...args],
    { cwd, env: { ...process.env, CARDBUSH_AGENT_TOKEN: '', CARDBUSH_AGENT_URL: '', CARDBUSH_CLI_CONFIG: join(tempRoot, 'unconfigured.json'), ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, stdout: '', stderr: '', combined: '', result: undefined };
  if (env.CARDBUSH_CLI_DATA_DIR) localChildren.set(child, env.CARDBUSH_CLI_DATA_DIR);
  child.stdout.setEncoding('utf8').on('data', text => { state.stdout += text; state.combined += text; });
  child.stderr.setEncoding('utf8').on('data', text => { state.stderr += text; state.combined += text; });
  child.stdin.on('error', () => {});
  state.result = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout: state.stdout, stderr: state.stderr, combined: state.combined })); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  if (!interactive) child.stdin.end(input);
  return state;
}

test('CLI help and argument errors do not need a server or credentials', async t => {
  const help = await cli(t, ['--help']).result;
  assert.equal(help.code, 0); assert.match(help.stdout, /cardbush --resume/); assert.match(help.stdout, /--full-access/);
  assert.match(help.stdout, /Usage: cardbush/); assert.doesNotMatch(help.stdout, /\p{Script=Han}/u);
  assert.match(help.stdout, /\/quit \(or \/exit\) exits/);
  assert.match(help.stdout, /Local Chrome\/Edge: approve the first connection in the CardBush extension window/);
  assert.match(help.stdout, /cardbush serve --data-dir/);
  assert.match(help.stdout, /--version/);
  assert.match(help.stdout, /no pairing code is needed\. The local App and CLI share connections and reconnect automatically/);
  assert.match(help.stdout, /is for manual connection or remote Agent pairing/);
  assert.match(help.stdout, /remote Agents keep separate connections/);
  assert.match(help.stdout, /Temporary disconnects do not require a new pairing code/);
  assert.match(help.stdout, /Model setting follows App config; Provider default lets the provider choose/);
  assert.match(help.stdout, /--model ID overrides this at launch/);
  assert.match(help.stdout, /native shell for command and path completion/);
  assert.match(help.stdout, /\/habit \[on\|off\|status\]/);
  assert.match(help.stdout, /\/prediction \[on\|off\|status\]/);
  const invalid = await cli(t, ['--permission', 'invalid']).result;
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /Invalid --permission/);
  const missing = await cli(t, ['--url', 'http://127.0.0.1:1', '--prompt', 'test']).result;
  assert.equal(missing.code, 1); assert.match(missing.stderr, /--token-file/);
  for (const args of [['resume'], ['--resume'], ['--resume', ''], ['--resume', 's', 'extra'], ['unknown'], ['--resume', 's', '--session', 's'], ['resume', 's', '--resume', 's'],
    ['--resume', 's', '--project', 'p'], ['--full-access', '--permission', 'task_free'], ['--local', '--url', 'http://127.0.0.1:1'], ['--local', '--token-file', 'token']]) {
    assert.equal((await cli(t, args).result).code, 1, JSON.stringify(args));
  }
});

test('desktop profile discovery uses the current account, independent of cwd', () => {
  assert.equal(localDesktopProfile({ APPDATA: 'C:/Users/me/AppData/Roaming' }, 'C:/Users/me', 'win32').replaceAll('\\', '/'), 'C:/Users/me/AppData/Roaming/cardbush');
  assert.equal(localDesktopProfile({}, '/Users/me', 'darwin').replaceAll('\\', '/'), '/Users/me/Library/Application Support/cardbush');
  assert.equal(localDesktopProfile({ XDG_CONFIG_HOME: '/settings' }, '/home/me', 'linux').replaceAll('\\', '/'), '/settings/cardbush');
});

test('native shell parsing is explicit and reuses platform discovery without noninteractive flags', () => {
  assert.equal(chatShellCommand('vim file.txt'), undefined, 'ordinary chat is not guessed to be a command');
  assert.equal(chatShellCommand('/shellish'), undefined);
  assert.equal(chatShellCommand(' /shell vim "file name.txt" '), 'vim "file name.txt"');
  assert.equal(chatShellCommand('!vim file.txt'), 'vim file.txt');
  assert.equal(chatShellCommand('/shell'), '');
  for (const platform of ['linux', 'win32']) {
    const context = { platform, arch: 'x64', env: { PATH: platform === 'win32' ? 'C:\\tools' : '/bin', PATHEXT: '.EXE' }, isExecutable: () => true };
    const invocation = chatShellInvocation('vim "file name.txt"', '/work', context);
    assert.ok(invocation.args.some(argument => argument.includes('vim "file name.txt"')));
    assert.ok(!invocation.args.includes('-NonInteractive'));
    const interactive = chatShellInvocation('', '/work', context);
    assert.ok(!interactive.args.includes('-Command') && !interactive.args.includes('-lc'));
  }
});

test('native child exit status returns without a model or extra window', async () => {
  assert.equal(await runChatShell('exit 7', process.cwd(), new AbortController().signal), 7);
  await assert.rejects(runChatShell('exit 0', process.cwd(), AbortSignal.abort()), { name: 'AbortError' });
});

test('configuration prompt runs bare editor commands and waits for a separate reload', async () => {
  const answers = ['vim "path with spaces/models.json"', '!echo done', '/shell', ''];
  const commands = [], io = terminal();
  io.ask = async () => answers.shift();
  io.runShell = async (command, cwd) => { commands.push({ command, cwd }); return 0; };
  assert.equal(await waitForChatConfiguration(io, new AbortController().signal, ['/cancel']), '');
  assert.deepEqual(commands.map(item => item.command), ['vim "path with spaces/models.json"', 'echo done', '']);
  assert.ok(commands.every(item => item.cwd === process.cwd()));
});

async function fixture(t) {
  await mkdir(tempRoot, { recursive: true }); const root = await mkdtemp(join(tempRoot, 'case-'));
  let nextTool, nextFailure, nextText, blocked = false; const calls = [], pending = new Set(), toolQueue = [];
  const release = () => { blocked = false; for (const finish of pending) finish(); pending.clear(); };
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 })); return; }
    calls.push(body); const index = calls.length;
    if (nextFailure) { const message = nextFailure; nextFailure = undefined; res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'invalid_request_error' } })); return; }
    const selected = nextTool ?? toolQueue.shift(); nextTool = undefined;
    const text = nextText ?? `fixture-answer-${index}`; nextText = undefined;
    const item = selected ? { id: `function-${index}`, call_id: `call-${index}`, type: 'function_call', name: selected.name,
      arguments: JSON.stringify(selected.arguments), status: 'completed' }
      : { id: `message-${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const response = { id: `response-${index}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    const finish = () => {
      if (res.destroyed || res.writableEnded) return;
      emit(selected ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
        : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
      emit({ type: 'response.output_item.done', output_index: 0, item });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }); res.end();
    };
    if (blocked) { pending.add(finish); res.once('close', () => pending.delete(finish)); }
    else finish();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  let service, http;
  t.after(async () => {
    release();
    const roots = new Set();
    for (const [client, dataRoot] of localClients) if (resolve(dataRoot).startsWith(root + sep)) {
      await client.close(); roots.add(dataRoot); localClients.delete(client);
    }
    for (const [child, dataRoot] of localChildren) if (resolve(dataRoot).startsWith(root + sep)) {
      roots.add(dataRoot);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
      localChildren.delete(child);
    }
    for (const dataRoot of roots) await localStopped(dataRoot);
    await http?.close(); await service?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.ok(resolve(root).startsWith(tempRoot + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  service = await AgentService.open({ dataRoot: join(root, 'service'), name: 'CLI fixture', env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
  await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [
    { id: 'fixture', provider: 'openai', model: 'fixture-model', apiKey: 'fixture-model-secret', baseURL: `http://127.0.0.1:${model.address().port}/v1` },
  ] } });
  const token = 'fixture-cli-token-'.repeat(3), tokenFile = join(root, 'access-token'); await writeFile(tokenFile, token + '\n');
  http = await serveAgentHttp(service, { host: '127.0.0.1', port: 0, token });
  const env = { CARDBUSH_AGENT_URL: `http://127.0.0.1:${http.port}`, CARDBUSH_AGENT_TOKEN: token, CARDBUSH_CLI_CONFIG: join(root, 'cli.json') };
  const cwd = join(root, '当前工作区 with spaces'); await mkdir(cwd);
  return { root, cwd, service, calls, env, tokenFile, release, setText: text => { nextText = text; }, setTool: tool => { nextTool = tool; }, tools: (...tools) => toolQueue.push(...tools), block: value => { blocked = value; }, failNext: message => { nextFailure = message; },
    stopService: async () => { await http.close(); http = undefined; await service.close(); } };
}

async function sharedCliEnv(f) {
  const profile = join(f.root, 'app-profile'), config = join(profile, 'product-host', 'config');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'models.json'), await readFile(join(f.service.root, 'config', 'models.json')));
  return { CARDBUSH_CLI_DATA_DIR: f.service.root, CARDBUSH_CLI_PROFILE_DIR: profile };
}

test('quit commands and completed prefixes exit locally with a resume hint without a model turn', async t => {
  const f = await fixture(t); let sessionId;
  for (const command of ['/q', '/qt', '/quit', '/exit']) {
    const process = cli(t, sessionId ? ['--resume', sessionId] : [], { env: f.env, cwd: f.cwd, interactive: true });
    await until(() => process.stderr, text => text.includes('❯ '));
    process.child.stdin.write(command.length <= 3 ? command + '\r' : `  ${command}  \r`);
    const result = await process.result;
    assert.equal(result.code, 0, result.stderr);
    const sessions = await f.service.call('sessions.list', { projection: 'summary' });
    assert.equal(sessions.length, 1); sessionId = sessions[0].sessionId;
    assert.match(result.stderr, /Resume this session: cardbush --resume/);
    assert.ok(result.stderr.includes(sessionId));
    assert.equal(f.calls.length, 0, `${command} must not be sent to the model`);
    assert.deepEqual(await f.service.call('chat.jobs', { sessionId }), []);
  }
  const literal = await cli(t, ['--resume', sessionId, '--prompt', '/quit'], { env: f.env }).result;
  assert.equal(literal.code, 0, literal.stderr); assert.equal(literal.stdout, 'fixture-answer-1\n');
  assert.equal(f.calls.length, 1, 'explicit --prompt text is not interpreted as an interactive command');
});

test('bare --resume picks a session, replays only final replies and inspects earlier tool receipts on demand', async t => {
  const f = await fixture(t), file = join(f.cwd, 'history-tool.txt');
  await writeFile(file, 'HISTORICAL_TOOL_RECEIPT');
  f.setTool({ name: 'read_file', arguments: { path: file } });
  const first = await cli(t, ['--prompt', 'First saved question'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(first.code, 0, first.stderr);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  const second = await cli(t, ['--resume', session.sessionId, '--prompt', 'Second saved question'], { env: f.env, cwd: f.root }).result;
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, 'fixture-answer-3\n', 'pipe output must not include historical replies');
  const before = f.calls.length, child = cli(t, ['--resume'], { env: f.env, cwd: f.root, interactive: true });
  await until(() => child.stderr, text => text.includes('Select a session:'));
  child.child.stdin.write('\t'); await delay(120); child.child.stdin.write('\r');
  await until(() => child.combined, text => text.includes('fixture-answer-3'));
  assert.match(terminalScreen(child.combined, 80).text, /fixture-answer-2[\s\S]*fixture-answer-3/);
  assert.equal(terminalScreen(child.combined, 80).text.split('fixture-answer-2').length, 2);
  assert.match(child.stderr, /First saved question[\s\S]*Second saved question/);
  assert.match(child.stderr, /Turn 1 · completed · \/tools --turn 1/);
  assert.doesNotMatch(child.stdout + child.stderr, /HISTORICAL_TOOL_RECEIPT|history-tool\.txt|Arguments:/);
  child.child.stdin.write('/tools --turn 1\r');
  await until(() => child.stderr, text => text.includes('Tools from turn 1'));
  assert.doesNotMatch(child.stderr, /HISTORICAL_TOOL_RECEIPT/);
  child.child.stdin.write('/tools 1 --turn 1\r');
  await until(() => child.stderr, text => text.includes('HISTORICAL_TOOL_RECEIPT'));
  assert.match(child.stderr, /Arguments:[\s\S]*history-tool\.txt[\s\S]*Result:/);
  child.child.stdin.write('/tools\r');
  await until(() => child.stderr, text => text.includes('No tools in this turn yet.'));
  child.child.stdin.write('/quit\r'); const result = await child.result;
  assert.equal(result.code, 0, result.stderr); assert.equal(f.calls.length, before, 'history and tool inspection never call the model');
  assert.equal((await f.service.call('sessions.list', { projection: 'summary' })).length, 1);
});

test('/session switches workspace and reference scope without replaying jobs or inheriting the old submission queue', async t => {
  const f = await fixture(t), other = join(f.root, 'other-workspace'); await mkdir(other);
  for (const cwd of [f.cwd, other]) {
    await writeFile(join(cwd, 'Read Me.md'), cwd === other ? 'SECOND_WORKSPACE' : 'FIRST_WORKSPACE');
    assert.equal((await cli(t, ['--prompt', 'Saved question'], { env: f.env, cwd }).result).code, 0);
  }
  const sessions = await f.service.call('sessions.list', { projection: 'summary' });
  const first = sessions.find(item => item.metadata.projectDir === f.cwd), second = sessions.find(item => item.metadata.projectDir === other);
  const child = cli(t, ['--resume', first.sessionId], { env: f.env, cwd: f.root, interactive: true });
  await until(() => child.combined, text => text.includes('fixture-answer-1'));
  child.child.stdin.write('/session\r');
  await until(() => child.stderr, text => text.includes('Select a session:'));
  child.child.stdin.write(second.sessionId + '\r');
  await until(() => child.combined, text => text.includes('fixture-answer-2'));
  child.child.stdin.write('Read @"Read Me.md"\r');
  await until(() => child.combined, text => text.includes('fixture-answer-3'));
  await until(() => child.stderr, text => text.includes('✓ Completed'));
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.at(-1).sessionId, second.sessionId);
  assert.deepEqual(state.jobs.at(-1).input.files, [join(other, 'Read Me.md')]);
  child.child.stdin.write('/session missing-session\r');
  await until(() => child.stderr, text => text.includes('Session not found.'));
  const beforePicker = child.stderr.length;
  child.child.stdin.write('/session\r');
  await until(() => child.stderr.slice(beforePicker), text => text.includes('Select a session:'));
  child.child.stdin.write('/cancel\r'); await delay(80);
  child.child.stdin.write('/quit\r'); const result = await child.result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stderr.endsWith(`Resume this session: cardbush --resume ${second.sessionId}\n`));
  assert.equal(f.calls.length, 3);
});

test('session switching restores model and effort, clears empty-session overrides and honors explicit launch models', async t => {
  const f = await fixture(t);
  const configuration = JSON.parse(await readFile(join(f.service.root, 'config', 'models.json'), 'utf8'));
  await f.service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [
    ...configuration.models, { ...configuration.models[0], id: 'second', model: 'second-model', reasoningEffort: 'medium' },
  ] } });
  const project = await f.service.call('projects.save', { name: 'Saved selections', path: f.cwd });
  const first = await f.service.call('sessions.create', { projectId: project.id });
  const second = await f.service.call('sessions.create', { projectId: project.id });
  const empty = await f.service.call('sessions.create', { projectId: project.id });
  for (const [session, modelId, reasoningEffort] of [[first, 'fixture', 'high'], [second, 'second', null]]) {
    const saved = await f.service.call('chat.send', { requestId: `saved-${modelId}`, turnId: `turn-${modelId}`,
      sessionId: session.sessionId, text: 'Saved question', modelId, reasoningEffort, permissionMode: 'task_free', language: 'en' });
    await until(() => f.service.call('chat.jobs', { sessionId: session.sessionId }), jobs => jobs.some(job => job.id === saved.id && job.status === 'completed'));
  }
  const child = cli(t, ['--resume', first.sessionId], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => child.combined, text => text.includes('fixture-answer-1'));
  assert.match(stripVTControlCharacters(child.stderr), /Effort: High/);
  child.child.stdin.write(`/session ${second.sessionId}\r`);
  await until(() => child.combined, text => text.includes('fixture-answer-2'));
  child.child.stdin.write('Continue second session\r');
  await until(() => child.stderr, text => text.includes('✓ Completed'));
  assert.equal(f.calls.at(-1).model, 'second-model');
  assert.equal(f.calls.at(-1).reasoning?.effort, undefined, 'saved Provider default overrides the model setting');
  const beforeEmpty = child.stderr.length;
  child.child.stdin.write(`/session ${empty.sessionId}\r`);
  await until(() => child.stderr.slice(beforeEmpty), text => text.includes('No completed conversation history yet.'));
  child.child.stdin.write('Continue empty session\r');
  await until(() => child.stderr, text => text.split('✓ Completed').length === 3);
  assert.equal(f.calls.at(-1).model, 'fixture-model');
  assert.equal(f.calls.at(-1).reasoning?.effort, undefined, 'empty sessions must not inherit the previous session selection');
  const beforeFirst = child.stderr.length;
  child.child.stdin.write(`/session ${first.sessionId}\r`);
  await until(() => child.stderr.slice(beforeFirst), text => text.includes(first.sessionId));
  child.child.stdin.write('Continue first session\r');
  await until(() => child.stderr, text => text.split('✓ Completed').length === 4);
  assert.equal(f.calls.at(-1).model, 'fixture-model');
  assert.equal(f.calls.at(-1).reasoning?.effort, 'high');
  child.child.stdin.write('/quit\r');
  const result = await child.result; assert.equal(result.code, 0, result.stderr);
  const override = await cli(t, ['--resume', first.sessionId, '--model', 'second', '--prompt', 'Explicit model override'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(override.code, 0, override.stderr);
  assert.equal(f.calls.at(-1).model, 'second-model');
  assert.equal(f.calls.at(-1).reasoning?.effort, 'medium', 'explicit launch model uses its own configured effort');
  assert.equal(f.calls.length, 6, 'selection and history never submit a model request');
});

test('resume picker cancel creates no session and switching while a task runs is never sent to the model', async t => {
  const f = await fixture(t);
  assert.equal((await cli(t, ['--prompt', 'Saved question'], { env: f.env, cwd: f.cwd }).result).code, 0);
  const cancel = cli(t, ['--resume'], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => cancel.stderr, text => text.includes('Select a session:'));
  cancel.child.stdin.write('/cancel\r'); assert.equal((await cancel.result).code, 0);
  assert.equal((await f.service.call('sessions.list', { projection: 'summary' })).length, 1);
  const child = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => child.stderr, text => text.includes('❯ '));
  f.block(true); child.child.stdin.write('Running question\r');
  await until(() => f.calls.length, value => value === 2);
  child.child.stdin.write('/session\r');
  await until(() => child.stderr, text => text.includes('Use this command after the current task finishes'));
  assert.equal((await f.service.call('chat.jobs', {})).length, 2);
  f.release(); await until(() => child.stderr, text => text.includes('✓ Completed'));
  child.child.stdin.write('/quit\r'); assert.equal((await child.result).code, 0);
  assert.equal(f.calls.length, 2);
});

test('CLI history pages preserve chronological order across more than 100 turns without downloading tool records', async t => {
  const { SessionStore, InMemoryRuntimeHost } = await import('../packages/bush-runtime/dist/index.js');
  const sessions = new SessionStore();
  for (let n = 1; n <= 105; n++) sessions.commitTurn('paged', { turnId: `turn-${n}`, turnSequence: n,
    createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', status: 'completed', reason: 'done', usage: {},
    messages: [{ messageId: `m-${n}`, turnId: `turn-${n}`, turnSequence: n, messageIndex: 0, createdAt: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content: `Final ${n}`, toolCalls: [] } }] });
  const host = new InMemoryRuntimeHost({ sessionStore: sessions }); t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const calls = [], client = { async call(method, input) { calls.push(input); return host.sendCommand(input); } };
  const history = await readChatHistory(client, 'paged', new AbortController().signal);
  assert.deepEqual(history.map(turn => turn.turnSequence), Array.from({ length: 105 }, (_, i) => i + 1));
  assert.equal(calls.length, 2); assert.ok(calls.every(input => input.kind === 'runtime.get_session_history' && input.payload.messageProjection === 'final_replies'));
});

test('resuming an active session replays committed replies and follows the existing job exactly once', async t => {
  const f = await fixture(t);
  assert.equal((await cli(t, ['--prompt', 'Saved question'], { env: f.env, cwd: f.cwd }).result).code, 0);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  f.block(true);
  const active = await f.service.call('chat.send', { requestId: 'resume-existing-job', sessionId: session.sessionId,
    turnId: 'resume-existing-turn', text: 'Already running', modelId: 'fixture', permissionMode: 'task_free' });
  await until(() => f.calls.length, value => value === 2);
  const child = cli(t, ['--resume', session.sessionId], { env: f.env, cwd: f.root, interactive: true });
  await until(() => child.combined, text => text.includes('fixture-answer-1'));
  await until(() => child.stderr, text => text.includes('Working'));
  assert.equal(f.calls.length, 2); f.release();
  await until(() => child.stderr, text => text.includes('✓ Completed'));
  child.child.stdin.write('/quit\r'); const result = await child.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(terminalScreen(result.combined, 80).text.split('fixture-answer-1').length, 2);
  assert.equal(terminalScreen(result.combined, 80).text.split('fixture-answer-2').length, 2);
  const jobs = await f.service.call('chat.jobs', { sessionId: session.sessionId });
  assert.equal(jobs.length, 2); assert.equal(jobs.at(-1).id, active.id); assert.equal(f.calls.length, 2);
});

test('CLI native commands stay local, return to chat and ignore child Ctrl+C without submitting model work', async t => {
  const f = await fixture(t), log = join(f.root, 'shell.jsonl');
  const process = cli(t, [], { env: { ...f.env, CARDBUSH_TEST_SHELL_LOG: log }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  for (const [index, command] of ['/shell vim "a file.txt"', '!echo done', '/sh'].entries()) {
    process.child.stdin.write(command + '\r');
    await until(() => readFile(log, 'utf8').catch(() => ''), text => text.trim().split('\n').length === index + 1);
    await delay(80);
  }
  process.child.stdin.write('/q\r'); const result = await process.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [
    { command: 'vim "a file.txt"', cwd: f.cwd }, { command: 'echo done', cwd: f.cwd }, { command: '', cwd: f.cwd },
  ]);
  assert.equal(f.calls.length, 0);
  assert.match(result.stderr, /Resume this session/);
});

test('CLI memory commands save independent session switches and restore them before any model turn', async t => {
  const f = await fixture(t);
  const first = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => first.stderr, text => text.includes('❯ '));
  const [session] = await f.service.call('sessions.list', { projection: 'summary' });
  const command = async (process, text, expected) => {
    const start = process.stderr.length;
    process.child.stdin.write(text + '\r');
    await until(() => stripVTControlCharacters(process.stderr.slice(start)), output => output.includes(expected));
  };
  await command(first, '/habit', '/habit: off (this session');
  await command(first, '/prediction', '/prediction: off (this session');
  await command(first, '/habit on', '/habit: on (this session');
  await command(first, '/prediction on', '/prediction: on (this session');
  await command(first, '/habit off', '/habit: off (this session');
  await command(first, '/prediction invalid', 'Usage: /prediction [on|off|status]');
  assert.equal(f.calls.length, 0, 'settings commands do not start model turns');
  first.child.stdin.write('/quit\r'); assert.equal((await first.result).code, 0);

  const resumed = cli(t, ['--resume', session.sessionId], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => resumed.stderr, text => text.includes('❯ '));
  await command(resumed, '/prediction status', '/prediction: on (this session');
  await command(resumed, '/habit status', '/habit: off (this session');
  // Another attached client changes one category; the next send must read the
  // server's current settings instead of reusing this window's old snapshot.
  await f.service.call('sessions.update', { sessionId: session.sessionId, individuation: { habits: true } });
  f.block(true); resumed.child.stdin.write('remember these preferences\r');
  await until(() => f.calls.length, count => count === 1);
  assert.match(JSON.stringify(f.calls[0]), /habits enabled; next-step prediction enabled/);
  await command(resumed, '/habit off', 'Use this command after the current task finishes');
  resumed.child.stdin.write('queued preferences\r');
  await until(() => f.service.call('chat.jobs', { sessionId: session.sessionId }), jobs => jobs.length === 2);
  f.release();
  await until(() => stripVTControlCharacters(resumed.stderr), text => text.split('✓ Completed').length === 3);
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.ok(state.jobs.every(job => job.input.individuation.habits && job.input.individuation.predictions));
  await command(resumed, '/prediction off', '/prediction: off (this session');
  await command(resumed, '/new', 'Session:');
  await command(resumed, '/habit status', '/habit: off (this session');
  await command(resumed, '/prediction status', '/prediction: off (this session');
  await command(resumed, `/session ${session.sessionId}`, session.sessionId);
  await command(resumed, '/habit status', '/habit: on (this session');
  await command(resumed, '/prediction status', '/prediction: off (this session');
  resumed.child.stdin.write('/quit\r'); assert.equal((await resumed.result).code, 0);
  const single = await cli(t, ['--resume', session.sessionId, '--prompt', 'resumed memory settings'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(single.code, 0, single.stderr);
  const saved = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8')).jobs.at(-1).input.individuation;
  assert.equal(saved.habits, true); assert.equal(saved.predictions, false);
  assert.equal(f.calls.length, 3);
});

test('browser pairing works from an idle or running CLI without sending codes or commands to the model', async t => {
  const f = await fixture(t), originalCall = f.service.call.bind(f.service), browserCalls = [];
  f.service.call = async (operation, input) => {
    if (operation !== 'browser.connector') return originalCall(operation, input);
    browserCalls.push(input);
    return { code: 'CB2.fixture.TERMINAL_ONLY_PAIRING_SECRET', expiresAt: '2026-10-24T12:00:00Z', browser: input.browser,
      extensionPath: join(f.root, 'extension') };
  };
  const terminal = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => terminal.stderr, text => text.includes('❯ '));
  terminal.child.stdin.write('/browser pair chrome\r');
  await until(() => terminal.stderr, text => text.includes('chrome pairing code'));
  assert.equal(f.calls.length, 0);
  f.block(true); terminal.child.stdin.write('one real task\r');
  await until(() => f.calls.length, n => n === 1);
  terminal.child.stdin.write('/browser pair edge Work\r');
  await until(() => terminal.stderr, text => text.includes('edge pairing code'));
  assert.deepEqual(browserCalls, [{ action: 'pair', browser: 'chrome' }, { action: 'pair', browser: 'edge', label: 'Work' }]);
  assert.equal((await f.service.call('chat.jobs', {})).length, 1, 'setup while running is not a queued model prompt');
  f.release(); await until(() => stripVTControlCharacters(terminal.stderr), text => text.includes('✓ Completed'));
  terminal.child.stdin.write('/exit\r'); const result = await terminal.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /TERMINAL_ONLY_PAIRING_SECRET/);
  const saved = await readFile(join(f.service.root, 'agent.json'), 'utf8');
  assert.doesNotMatch(JSON.stringify(f.calls) + saved, /TERMINAL_ONLY_PAIRING_SECRET/);
  const userInputs = f.calls.flatMap(call => call.input.filter(message => message.role === 'user'));
  assert.doesNotMatch(JSON.stringify(userInputs) + saved, /\/browser pair/, 'setup commands never become user messages or saved jobs; system help may describe them');
});

test('queued CLI prompts appear once in turn order after the preceding completion', async t => {
  const f = await fixture(t); f.block(true);
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('/model fixture\r');
  await until(() => process.stderr, text => text.includes('Select Reasoning Level for fixture-model'));
  process.child.stdin.write('high\r');
  await until(() => process.stderr, text => text.includes('Switched to: fixture-model'));
  process.child.stdin.write('first ordering question\r');
  await until(() => f.calls.length, count => count === 1);
  for (const [index, question] of ['second ordering question', 'third ordering question'].entries()) {
    process.child.stdin.write(question + '\r');
    await until(() => f.service.call('chat.jobs', {}), jobs => jobs.length === index + 2);
  }
  await until(() => process.stderr, text => text.includes('2 queued'));
  assert.doesNotMatch(process.stderr, /❯ (?:second|third) ordering question/, 'queue submission must not commit prompts into the active reply');
  f.release();
  await until(() => process.stderr, text => text.split('✓ Completed').length === 4);
  process.child.stdin.write('/q\r'); const result = await process.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(call => call.reasoning?.effort), ['high', 'high', 'high'], 'queued turns keep the selected effort');
  const visible = stripVTControlCharacters(result.stderr);
  assert.match(visible, /❯ first ordering question[\s\S]*✓ Completed[\s\S]*❯ second ordering question[\s\S]*✓ Completed[\s\S]*❯ third ordering question[\s\S]*✓ Completed/);
  for (const prefix of ['first', 'second', 'third']) assert.equal(visible.split(`❯ ${prefix} ordering question`).length, 2, 'each prompt is committed exactly once');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(terminalScreen(result.combined, 80).text.match(/fixture-answer-\d+/g), ['fixture-answer-1', 'fixture-answer-2', 'fixture-answer-3']);
  const lastJob = (await f.service.call('chat.jobs', {})).at(-1);
  assert.equal(lastJob.reasoningEffort, 'high');
  assert.equal(lastJob.input, undefined, 'resuming uses public selection fields, not private job inputs');
  const resumed = await cli(t, ['--resume', lastJob.sessionId, '--prompt', 'resume chosen high effort'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(f.calls.at(-1).reasoning?.effort, 'high', 'resume keeps explicit effort');
});

test('real CLI /artifact lists turn files, Tab selects and Enter downloads/opens once without another model request', async t => {
  let process, resumed, finished = false, stage = 'setup';
  t.after(() => {
    if (!finished) t.diagnostic(stage + '\n' + stripVTControlCharacters((resumed ?? process)?.stderr ?? '').slice(-7000));
    for (const item of [process, resumed]) if (item?.child.exitCode === null) item.child.kill();
  });
  const f = await fixture(t), log = join(f.root, 'opened.jsonl');
  const first = join(f.cwd, '中文 note.md'), second = join(f.cwd, 'result.csv');
  await writeFile(first, 'first file'); await writeFile(second, 'value\nsecond file');
  f.setText(`[Note](<${first}>) and [Table](<${second}>)`);
  let downloads = 0;
  const original = f.service.call.bind(f.service);
  f.service.call = async (operation, input, ...rest) => { if (operation === 'files.read') downloads++; return original(operation, input, ...rest); };
  process = cli(t, [], { env: { ...f.env, CARDBUSH_TEST_OPEN_ARTIFACT_LOG: log }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('make two files\r');
  await until(() => process.stderr, text => text.includes('✓ Completed'));
  stage = 'list artifacts';
  process.child.stdin.write('/artifact\r');
  await until(() => process.stderr, text => text.includes('Files from this turn'));
  await delay(120); process.child.stdin.write('\t');
  stage = 'select first';
  await until(() => process.stderr, text => text.includes('/artifact 1'));
  await delay(100); process.child.stdin.write('\t');
  stage = 'select second';
  await until(() => process.stderr, text => text.includes('/artifact 2'));
  assert.equal(downloads, 0, 'listing and Tab never transfer or open files');
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '');
  process.child.stdin.write('\r');
  stage = 'open';
  const opened = await until(() => readFile(log, 'utf8').catch(() => ''), text => text.trim().length > 0);
  const entries = opened.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 1); assert.equal(entries[0].content, 'value\nsecond file'); assert.equal(entries[0].kind, 'file');
  assert.equal(downloads, 1); assert.equal(f.calls.length, 1);
  await until(() => process.stderr, text => text.includes('Opened downloaded copy: Table'));
  stage = 'quit';
  process.child.stdin.write('/q\r'); assert.equal((await process.result).code, 0);
  const directory = resolve(dirname(entries[0].path)); assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'cardbush-artifact-'));
  await rm(directory, { recursive: true, force: true });
  const sessions = await original('sessions.list', { projection: 'summary' });
  stage = 'resume';
  resumed = cli(t, ['--resume', sessions[0].sessionId], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => resumed.stderr, text => text.includes('❯ '));
  resumed.child.stdin.write('/artifact\r');
  await until(() => resumed.stderr, text => text.includes('Files from this turn'));
  assert.match(resumed.stderr, /1\. Note/); assert.match(resumed.stderr, /2\. Table/);
  stage = 'cancel selection and quit resumed session';
  resumed.child.stdin.write('\x1b'); await delay(100); resumed.child.stdin.write('/q\r');
  assert.equal((await resumed.result).code, 0); assert.equal(f.calls.length, 1);
  finished = true;
});

test('live queue and guidance reuse Agent jobs, recover a lost receipt and retain a draft across turns', async t => {
  const f = await fixture(t); f.block(true);
  const original = f.service.call.bind(f.service); let lost = false;
  f.service.call = async (operation, input, ...rest) => {
    const result = await original(operation, input, ...rest);
    if (operation === 'chat.send' && input.text === 'queued next task' && !lost) { lost = true; throw new Error('Fixture lost send receipt'); }
    return result;
  };
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('first task\r');
  await until(() => f.calls.length, count => count === 1);
  process.child.stdin.write('queued next task\r');
  await until(() => original('chat.jobs', {}), jobs => jobs.length === 2 && jobs[1].status === 'queued');
  await until(() => process.stderr, text => text.includes('1 queued'));
  assert.equal(f.calls.length, 1, 'ordinary Enter does not interrupt the running turn');
  f.block(false); process.child.stdin.write('use the existing files\n'); // Ctrl+Enter in Windows Terminal
  await until(() => original('chat.jobs', {}), jobs => jobs.length === 3 && jobs[2].guidance?.applied);
  process.child.stdin.write('preserved draft');
  const jobs = await until(() => original('chat.jobs', {}), jobs => jobs.filter(job => !job.guidance).every(job => job.status === 'completed'));
  await until(() => process.stderr, text => text.split('✓ Completed').length === 3);
  assert.equal(jobs.length, 3); assert.equal(jobs[2].guidance.turnId, jobs[0].turnId);
  assert.match(process.stderr, /\[Applied\] Guidance received/);
  assert.match(JSON.stringify(f.calls[1].input), /use the existing files/);
  assert.equal(f.calls.length, 3, 'one interrupted call, its continuation and one queued turn');
  process.child.stdin.write(' completed\r');
  await until(() => original('chat.jobs', {}), jobs => jobs.length === 4 && jobs[3].status === 'completed');
  await until(() => process.stderr, text => text.split('✓ Completed').length === 4);
  process.child.stdin.write('/quit\r'); const result = await process.result;
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.equal(state.jobs[3].input.text, 'preserved draft completed');
  assert.equal(state.jobs.filter(job => job.input.text === 'queued next task').length, 1);
  assert.equal(stripVTControlCharacters(result.stderr).split('❯ queued next task').length, 2, 'recovering a send receipt cannot duplicate its displayed prompt');
});

test('live guidance racing task completion runs the same queued job once as a new turn', async t => {
  const f = await fixture(t); f.block(true);
  const original = f.service.call.bind(f.service);
  f.service.call = async (operation, input, ...rest) => {
    if (operation === 'chat.queue' && input.action === 'guide') {
      f.release();
      await until(() => original('chat.jobs', {}), jobs => jobs[0]?.status === 'completed');
    }
    return original(operation, input, ...rest);
  };
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('finishing task\r'); await until(() => f.calls.length, count => count === 1);
  process.child.stdin.write('/steer new instruction\r');
  const jobs = await until(() => original('chat.jobs', {}), jobs => jobs.length === 2 && jobs.every(job => job.status === 'completed'));
  await until(() => process.stderr, text => text.split('✓ Completed').length === 3);
  assert.equal(jobs.filter(job => job.guidance).length, 0); assert.equal(f.calls.length, 2);
  assert.match(process.stderr, /previous task ended/); assert.doesNotMatch(process.stderr, /\[Applied\]|\[Failed\]/);
  process.child.stdin.write('/q\r'); const result = await process.result;
  assert.equal(result.code, 0, result.stderr);
  const visible = stripVTControlCharacters(result.stderr);
  assert.match(visible, /✓ Completed[\s\S]*❯ new instruction[\s\S]*✓ Completed/);
  assert.equal(visible.split('❯ new instruction').length, 2, 'guidance that becomes a new turn owns a single prompt before its reply');
});

test('real Agent HTTP: one-shot, piped multiline, continuation, project and model reuse', async t => {
  const f = await fixture(t); const before = await f.service.call('product.command', { kind: 'models.get' });
  const projectDir = join(f.root, 'project'); await mkdir(projectDir);
  const project = await f.service.call('projects.save', { name: 'CLI project', path: projectDir });
  const models = await cli(t, ['--models'], { env: f.env }).result;
  assert.equal(models.code, 0); assert.equal(models.stdout, 'fixture\tfixture-model (default)\n');
  const one = await cli(t, ['--token-file', f.tokenFile, '--project', project.id, '--prompt', 'first instruction'], { env: f.env }).result;
  assert.equal(one.code, 0, one.stderr); assert.equal(one.stdout, 'fixture-answer-1\n');
  const sessions = await f.service.call('sessions.list', { projection: 'summary' }); assert.equal(sessions.length, 1);
  assert.equal(sessions[0].metadata.projectId, project.id);
  const sessionId = sessions[0].sessionId;
  assert.match(one.stderr, new RegExp(`cardbush --resume ${sessionId}`));
  const piped = await cli(t, ['--session', sessionId], { env: f.env, input: 'line one\n第二行\n' }).result;
  assert.equal(piped.code, 0, piped.stderr); assert.equal(piped.stdout, 'fixture-answer-2\n');
  const saved = await f.service.call('sessions.get', { sessionId }); assert.equal(saved.turns.length, 2);
  assert.match(JSON.stringify(f.calls[1].input), /first instruction/); assert.match(JSON.stringify(f.calls[1].input), /第二行/);
  const listed = await cli(t, ['--sessions'], { env: f.env }).result; assert.match(listed.stdout, new RegExp(sessionId));
  const invalid = await cli(t, ['--model', 'missing', '--prompt', 'not sent'], { env: f.env }).result;
  assert.equal(invalid.code, 1); assert.equal(f.calls.length, 2);
  const large = await cli(t, [], { env: f.env, input: '中'.repeat(750000) }).result;
  assert.equal(large.code, 1); assert.match(large.stderr, /too large/); assert.equal(f.calls.length, 2);
  assert.deepEqual(await f.service.call('product.command', { kind: 'models.get' }), before);
  assert.doesNotMatch([models, one, piped, listed, invalid].map(result => result.stdout + result.stderr).join('\n'), /fixture-model-secret|fixture-cli-token/);
});

test('real Agent file hints attach a completed reference only on Enter and --resume keeps its workspace', async t => {
  const f = await fixture(t), file = join(f.cwd, 'Read Me.md'); await writeFile(file, 'FILE_REFERENCE_FIXTURE');
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('查看 @Re');
  await until(() => process.stderr, text => text.includes('Read Me.md') && text.includes('Tab complete'));
  assert.equal(f.calls.length, 0, 'listing suggestions never invokes the model');
  process.child.stdin.write('\t'); await delay(100);
  assert.equal(f.calls.length, 0, 'Tab only fills the draft');
  process.child.stdin.write('\r');
  await until(() => process.stderr, text => text.includes('Completed'));
  process.child.stdin.write('/exit\r');
  const result = await process.result; assert.equal(result.code, 0, result.stderr);
  let state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  const input = state.jobs.at(-1).input;
  assert.equal(input.text, '查看 @"Read Me.md"'); assert.deepEqual(input.files, [file]);
  assert.equal(input.language, 'en');
  const sent = JSON.stringify(f.calls[0]);
  assert.match(sent, /ui_language_fallback: en/);
  assert.match(sent, /human user's explicit language preference/);
  assert.match(sent, /查看/, 'the English UI never replaces the human language evidence');
  const resumed = await cli(t, ['--resume', input.sessionId, '--prompt', '再次查看 @"Read Me.md"'], { env: f.env, cwd: f.root }).result;
  assert.equal(resumed.code, 0, resumed.stderr);
  state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.at(-1).input.sessionId, input.sessionId);
  assert.deepEqual(state.jobs.at(-1).input.files, [file], 'resume uses the existing workspace, not the new shell cwd');
  assert.match(JSON.stringify(f.calls.at(-1)), /Read Me\.md/);
});

test('real Agent and native readline: approval, question, multiple turns and Ctrl+C stop', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.txt'); await writeFile(outside, 'APPROVED_FILE');
  const stopRequests = [], call = f.service.call.bind(f.service);
  f.service.call = (operation, input, ...rest) => {
    if (operation === 'chat.stop') stopRequests.push(input.id);
    return call(operation, input, ...rest);
  };
  const process = cli(t, [], { env: { ...f.env, NO_COLOR: '', TERM: 'xterm' }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  f.setTool({ name: 'read_file', arguments: { path: outside } }); process.child.stdin.write('read file\n');
  await until(() => process.stderr, text => text.includes('Choose an approval'));
  assert.equal(f.calls.length, 1); process.child.stdin.write('\x1b[B\r');
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'completed');
  assert.match(JSON.stringify(f.calls[1]), /APPROVED_FILE/);
  f.tools({ name: 'request_user_input_async', arguments: { questions: [{ id: 'scope', prompt: 'Pick a scope', options: ['First', 'Second'] }] } },
    { name: 'tasks', arguments: { action: 'wait', yield_time_ms: 15000 } });
  process.child.stdin.write('choose scope\n');
  await until(() => process.stderr, text => text.includes('/cancel'));
  process.child.stdin.write('\x1b[B\r');
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'completed');
  assert.match(JSON.stringify(f.calls.at(-1)), /Second/);
  f.block(true); const previous = f.calls.length; process.child.stdin.write('long task\n');
  await until(() => f.calls.length, count => count > previous);
  const running = (await f.service.call('chat.jobs')).at(-1);
  process.child.stdin.write('\x03');
  await until(() => process.stderr, text => text.includes('Stop requested'));
  assert.deepEqual(stopRequests, [running.id], 'Ctrl+C must stop the running task once, not the preceding completed task');
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'stopped');
  f.block(false); process.child.stdin.write('/exit\n');
  const result = await process.result; assert.equal(result.code, 0, result.stderr);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  assert.ok(result.stderr.endsWith(`Resume this session: cardbush --resume ${session.sessionId}\n`), 'NO_COLOR and normal exit preserve a copyable resume command');
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[\?1049[hl]/, 'never enters an alternate terminal screen');
  assert.equal(f.calls.length, previous + 1, 'Ctrl+C must not resubmit the task');
});

test('initial submission with a lost receipt follows the committed job without exiting or resubmitting', async t => {
  let process; t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), call = f.service.call.bind(f.service); let sends = 0;
  f.service.call = async (operation, input, ...rest) => {
    const result = await call(operation, input, ...rest);
    if (operation === 'chat.send' && ++sends === 1) throw new Error('Fixture first receipt lost');
    return result;
  };
  f.block(true);
  process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('original submission\r');
  await until(() => f.calls.length, count => count === 1);
  f.release();
  await until(() => process.stderr, text => text.includes('✓ Completed ·'));
  assert.equal(process.child.exitCode, null); assert.equal(sends, 1);
  assert.equal((await call('chat.jobs', {})).length, 1); assert.equal(f.calls.length, 1);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('input entered while the first submission awaits its receipt reaches the queue once', async t => {
  let process; const receipt = Promise.withResolvers();
  t.after(() => { receipt.resolve(); if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), call = f.service.call.bind(f.service); let sends = 0;
  f.service.call = async (operation, input, ...rest) => {
    const result = await call(operation, input, ...rest);
    if (operation === 'chat.send' && ++sends === 1) await receipt.promise;
    return result;
  };
  f.block(true);
  process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('first awaiting receipt\r');
  await until(() => f.calls.length, count => count === 1);
  process.child.stdin.write('buffered during receipt\r'); await delay(50);
  assert.equal((await call('chat.jobs', {})).length, 1);
  receipt.resolve();
  await until(() => call('chat.jobs', {}), jobs => jobs.length === 2);
  f.release();
  await until(() => process.stderr, text => (text.match(/✓ Completed ·/g) ?? []).length === 2);
  assert.equal(sends, 2); assert.equal(f.calls.length, 2);
  assert.equal(stripVTControlCharacters(process.stderr).split('❯ buffered during receipt').length, 2);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('resumed observer never stops another CLI queued successor during the handoff', async t => {
  let process; t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), gate = join(f.root, 'foreign-handoff-gate'), stops = [], call = f.service.call.bind(f.service);
  f.service.call = (operation, input, ...rest) => { if (operation === 'chat.stop') stops.push(input.id); return call(operation, input, ...rest); };
  const session = await call('sessions.create', {});
  const send = id => call('chat.send', { requestId: id, sessionId: session.sessionId, text: id, modelId: 'fixture', permissionMode: 'task_free', language: 'en' });
  f.block(true); await send('peer-first'); await until(() => f.calls.length, count => count === 1); await send('peer-next');
  process = cli(t, ['--resume', session.sessionId], { env: { ...f.env, CARDBUSH_TEST_HANDOFF_GATE: gate }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('Working'));
  f.release(); f.block(true);
  await until(() => process.stderr, text => text.includes('[Test: observer handoff]'));
  await until(() => f.calls.length, count => count === 2);
  process.child.stdin.write('\x03'); await delay(150);
  assert.deepEqual(stops, [], 'restoring queued jobs must not claim ownership of a peer submission');
  assert.equal((await call('chat.jobs', {})).at(-1).status, 'running');
  await writeFile(gate, 'continue'); f.release();
  await until(() => process.stderr, text => (text.match(/✓ Completed ·/g) ?? []).length === 2);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('lost submission and status receipts keep the CLI open and reconcile a completed job on Enter', async t => {
  let process; t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), call = f.service.call.bind(f.service); let unavailable = false, sends = 0;
  f.service.call = async (operation, input, ...rest) => {
    if (unavailable && operation === 'chat.jobs') throw new Error('Fixture status unavailable');
    const result = await call(operation, input, ...rest);
    if (operation === 'chat.send') { sends++; unavailable = true; throw new Error('Fixture receipt lost'); }
    return result;
  };
  f.block(true);
  process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('uncertain original\r');
  await until(() => process.stderr, text => text.includes('Reconnect to the Agent?'));
  assert.equal(process.child.exitCode, null); assert.doesNotMatch(process.stderr, /Task failed/);
  f.release(); await until(() => call('chat.jobs', {}), jobs => jobs[0]?.status === 'completed');
  unavailable = false; process.child.stdin.write('\r');
  await until(() => process.stderr, text => text.includes('✓ Completed ·'));
  assert.equal(sends, 1); assert.equal(f.calls.length, 1);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
  assert.equal((await call('chat.jobs', {})).length, 1);
});

test('two CLI approval pickers racing on Enter produce one decision and one tool execution', async t => {
  const processes = [], barrier = Promise.withResolvers(); t.after(() => { barrier.resolve(); for (const process of processes) if (process.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), outside = join(f.root, 'shared-approval.txt'); await writeFile(outside, 'EXECUTED_ONCE');
  const session = await f.service.call('sessions.create', {}), call = f.service.call.bind(f.service);
  let arrivals = 0, conflicts = 0;
  f.service.call = async (operation, input, ...rest) => {
    if (operation !== 'runtime.command' || input.kind !== 'runtime.answer_permission') return call(operation, input, ...rest);
    if (++arrivals === 2) barrier.resolve();
    await barrier.promise;
    try { return await call(operation, input, ...rest); }
    catch (error) { if (error.code === 'permission_not_pending') conflicts++; throw error; }
  };
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const job = await call('chat.send', { requestId: 'shared-approval', sessionId: session.sessionId, text: 'read fixture', modelId: 'fixture', permissionMode: 'task_free', language: 'en' });
  for (let index = 0; index < 2; index++) processes.push(cli(t, ['--resume', session.sessionId], { env: f.env, cwd: f.cwd, interactive: true }));
  await Promise.all(processes.map(process => until(() => process.stderr, text => text.includes('Choose an approval'))));
  for (const process of processes) process.child.stdin.write('\x1b[B\r');
  await Promise.all(processes.map(process => until(() => process.stderr, text => text.includes('✓ Completed ·'))));
  assert.equal(arrivals, 2); assert.equal(conflicts, 1); assert.equal(f.calls.length, 2);
  const events = await call('runtime.command', { kind: 'runtime.list_turn_events', payload: { sessionId: session.sessionId, turnId: job.turnId } });
  assert.equal(events.filter(event => event.kind === 'permission_answered').length, 1);
  assert.equal(events.filter(event => event.kind === 'tool_returned' && event.payload.toolName === 'read_file').length, 1);
  for (const process of processes) { assert.equal(process.child.exitCode, null); process.child.stdin.write('/exit\r'); }
  for (const process of processes) assert.equal((await process.result).code, 0);
});

test('a failed stop confirmation can reconnect to the original job without repeating the stop', async t => {
  let process; t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), call = f.service.call.bind(f.service); let stops = 0;
  f.service.call = (operation, input, ...rest) => {
    if (operation === 'chat.stop') { stops++; throw new Error('Fixture stop unavailable'); }
    return call(operation, input, ...rest);
  };
  f.block(true);
  process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('observe after failed stop\r');
  await until(() => f.calls.length, count => count === 1);
  await until(() => process.stderr, text => text.includes('Working'));
  process.child.stdin.write('\x03');
  await until(() => process.stderr, text => text.includes('Reconnect to this task?'));
  assert.equal(process.child.exitCode, null);
  process.child.stdin.write('\r');
  // A successful observation opens another event stream; do not release the
  // provider until the reconnect choice has been processed.
  await delay(150); f.release();
  await until(() => process.stderr, text => text.includes('✓ Completed ·'));
  assert.equal(stops, 1); assert.equal(f.calls.length, 1); assert.equal((await call('chat.jobs', {})).length, 1);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('a second CLI submission observes the earlier pending approval before its own queued turn', async t => {
  let process; t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), outside = join(f.root, 'peer-approval.txt'); await writeFile(outside, 'PEER_APPROVED');
  const session = await f.service.call('sessions.create', {});
  process = cli(t, ['--resume', session.sessionId], { env: { ...f.env, CARDBUSH_TEST_CHAT_READY: '1' }, cwd: f.cwd, interactive: true });
  // The live footer is drawn before history restoration and the first jobs
  // snapshot finish. Start the peer only after this CLI is actually reading
  // chat input, otherwise the fixture can put its message into an approval.
  await until(() => process.stderr, text => text.includes('[Test: chat input ready]'));
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const first = await f.service.call('chat.send', { requestId: 'peer-approval', sessionId: session.sessionId, text: 'read fixture', modelId: 'fixture', permissionMode: 'task_free', language: 'en' });
  await until(() => f.service.call('runtime.command', { kind: 'runtime.list_turn_events', payload: { sessionId: session.sessionId, turnId: first.turnId } }), events => events.some(event => event.kind === 'permission_requested'));
  process.child.stdin.write('second CLI message\r');
  await until(() => process.stderr, text => text.includes('Choose an approval'));
  process.child.stdin.write('\x1b[B\r');
  await until(() => f.service.call('chat.jobs', {}), jobs => jobs.length === 2 && jobs.every(job => job.status === 'completed'));
  await until(() => process.stderr, text => (text.match(/✓ Completed ·/g) ?? []).length === 2);
  assert.equal(f.calls.length, 3, 'two turns with one approved tool, without replay');
  assert.match(JSON.stringify(f.calls[1]), /PEER_APPROVED/);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('real CLI stays open after a late approval conflict and completes the original job', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside-race.txt'); await writeFile(outside, 'APPROVED_ONCE');
  const call = f.service.call.bind(f.service); let answers = 0;
  f.service.call = async (operation, input, ...rest) => {
    const value = await call(operation, input, ...rest);
    if (operation === 'runtime.command' && input.kind === 'runtime.answer_permission') {
      answers++;
      // The decision won elsewhere just before this client's acknowledgement.
      throw Object.assign(new Error(`Permission ${input.payload.permissionId} is not pending.`), { code: 'permission_not_pending' });
    }
    return value;
  };
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  f.setTool({ name: 'read_file', arguments: { path: outside } }); process.child.stdin.write('read fixture\r');
  await until(() => process.stderr, text => text.includes('Choose an approval'));
  process.child.stdin.write('\x1b[B\r');
  await until(() => process.stderr, text => text.includes('✓ Completed ·'));
  assert.equal(process.child.exitCode, null, 'an expired permission must not exit the process');
  assert.equal(answers, 1);
  assert.equal((await call('chat.jobs', {})).length, 1);
  assert.match(JSON.stringify(f.calls[1].input.filter(item => item.type === 'function_call_output')), /APPROVED_ONCE/);
  assert.doesNotMatch(process.stderr, /Task failed|Reconnect to this task/);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('real CLI keeps an active job open after observation fails and Enter reconnects without resubmission', async t => {
  const f = await fixture(t), stream = f.service.eventStream.bind(f.service); let fail = true;
  f.service.eventStream = (input, signal) => {
    if (!fail) return stream(input, signal);
    fail = false; return (async function* () { throw new Error('Fixture observation interrupted'); })();
  };
  f.block(true);
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('continue original job\r');
  await until(() => process.stderr, text => text.includes('Reconnect to this task?'));
  await delay(50);
  assert.equal(process.child.exitCode, null); assert.doesNotMatch(process.stderr, /Task failed/);
  assert.equal((await f.service.call('chat.jobs')).length, 1);
  f.release(); process.child.stdin.write('\r');
  await until(() => process.stderr, text => text.includes('✓ Completed ·'));
  assert.equal(process.child.exitCode, null); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.call('chat.jobs')).length, 1);
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
});

test('explicit CLI exit stops its queued messages before the active turn and preserves peer work', async t => {
  let process; t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), stops = [], call = f.service.call.bind(f.service);
  f.service.call = (operation, input, ...rest) => { if (operation === 'chat.stop') stops.push(input.id); return call(operation, input, ...rest); };
  f.block(true);
  process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('active owned task\r'); await until(() => f.calls.length, count => count === 1);
  process.child.stdin.write('queued owned task\r');
  const jobs = await until(() => call('chat.jobs', {}), jobs => jobs.length === 2);
  const first = jobs[0], queued = jobs[1];
  const peer = await call('chat.send', { requestId: 'peer-survives-exit', sessionId: first.sessionId, text: 'peer task', modelId: 'fixture', permissionMode: 'task_free', language: 'en' });
  process.child.stdin.write('/exit\r'); assert.equal((await process.result).code, 0);
  const after = await call('chat.jobs', {});
  assert.equal(after.find(job => job.id === queued.id).status, 'stopped');
  assert.equal(after.find(job => job.id === first.id).status, 'stopped');
  assert.deepEqual(stops, [queued.id, first.id]);
  assert.ok(['running', 'queued'].includes(after.find(job => job.id === peer.id).status));
  f.release(); await until(() => call('chat.jobs', {}), jobs => jobs.at(-1).status === 'completed');
  assert.equal(f.calls.length, 2, 'the owned queued message never starts after exit');
});

test('explicit exit waits for an in-flight queue receipt before stopping owned jobs', async t => {
  let window; const receipt = Promise.withResolvers();
  t.after(() => { receipt.resolve(); if (window?.child.exitCode === null) window.child.kill(); });
  const f = await fixture(t), call = f.service.call.bind(f.service); let sends = 0;
  f.service.call = async (operation, input, ...rest) => {
    const result = await call(operation, input, ...rest);
    if (operation === 'chat.send' && ++sends === 2) await receipt.promise;
    return result;
  };
  f.block(true);
  window = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => window.stderr, text => text.includes('❯ '));
  window.child.stdin.write('active before exit\r'); await until(() => f.calls.length, count => count === 1);
  window.child.stdin.write('pending receipt before exit\r');
  await until(() => call('chat.jobs', {}), jobs => jobs.length === 2);
  window.child.stdin.write('/exit\r'); await delay(80);
  assert.equal(window.child.exitCode, null, 'exit must reconcile already submitted work');
  receipt.resolve(); assert.equal((await window.result).code, 0);
  assert.deepEqual((await call('chat.jobs', {})).map(job => job.status), ['stopped', 'stopped']);
  assert.equal(f.calls.length, 1);
});

test('failed exit cancellation keeps the CLI open until a later explicit exit confirms stop', async t => {
  let window; t.after(() => { if (window?.child.exitCode === null) window.child.kill(); });
  const f = await fixture(t), call = f.service.call.bind(f.service); let fail = true;
  f.service.call = (operation, input, ...rest) => {
    if (operation === 'chat.stop' && fail) throw new Error('Fixture stop temporarily unavailable');
    return call(operation, input, ...rest);
  };
  f.block(true);
  window = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => window.stderr, text => text.includes('❯ '));
  window.child.stdin.write('active failed exit\r'); await until(() => f.calls.length, count => count === 1);
  window.child.stdin.write('/exit\r');
  await until(() => window.stderr, text => text.includes('Reconnect to this task?'));
  assert.equal(window.child.exitCode, null);
  assert.equal((await call('chat.jobs', {}))[0].status, 'running');
  fail = false; window.child.stdin.write('\r'); await delay(100); window.child.stdin.write('/exit\r');
  assert.equal((await window.result).code, 0);
  assert.equal((await call('chat.jobs', {}))[0].status, 'stopped');
  assert.equal(f.calls.length, 1);
});

test('Ctrl+C between observers stops the already-running queued successor without exiting the CLI', async t => {
  let process;
  t.after(() => { if (process?.child.exitCode === null) process.child.kill(); });
  const f = await fixture(t), gate = join(f.root, 'handoff-gate'), stops = [], call = f.service.call.bind(f.service);
  f.service.call = (operation, input, ...rest) => { if (operation === 'chat.stop') stops.push(input.id); return call(operation, input, ...rest); };
  f.block(true);
  process = cli(t, [], { env: { ...f.env, CARDBUSH_TEST_HANDOFF_GATE: gate }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  process.child.stdin.write('first task\r'); await until(() => f.calls.length, count => count === 1);
  process.child.stdin.write('queued task\r'); await until(() => process.stderr, text => text.includes('1 queued'));
  f.release(); f.block(true);
  await until(() => process.stderr, text => text.includes('[Test: observer handoff]'));
  await until(() => f.calls.length, count => count === 2);
  const successor = (await call('chat.jobs', {})).at(-1); assert.equal(successor.status, 'running');
  process.child.stdin.write('\x03');
  await until(() => process.stderr, text => text.includes('Stop requested'));
  await until(() => call('chat.jobs', {}), jobs => jobs.at(-1)?.status === 'stopped');
  assert.equal(process.child.exitCode, null); assert.deepEqual(stops, [successor.id]);
  await writeFile(gate, 'continue');
  await until(() => process.stderr, text => text.includes('Stopped ·'));
  process.child.stdin.write('/exit\r'); const result = await process.result;
  assert.equal(result.code, 0, result.stderr); assert.equal(f.calls.length, 2);
});

test('real Agent and native readline submit all question answers to the offline provider together', async t => {
  const f = await fixture(t);
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  f.tools({ name: 'request_user_input_async', arguments: { questions: multiQuestion.questions } },
    { name: 'tasks', arguments: { action: 'wait', yield_time_ms: 15000 } });
  process.child.stdin.write('ask two questions\n');
  await until(() => process.stderr, text => text.includes('[1/2] Which version?') && text.includes('/cancel'));
  process.child.stdin.write('2\n');
  await until(() => process.stderr, text => text.includes('[2/2] Which period?'));
  await until(() => f.calls.length, count => count === 2);
  const job = (await f.service.call('chat.jobs')).at(-1);
  const pending = await f.service.call('runtime.command', { kind: 'runtime.list_solution_selections', payload: { sessionId: job.sessionId } });
  assert.equal(pending.length, 1, 'the question task stays pending until all answers are submitted');
  process.child.stdin.write('Last month\n');
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'completed');
  assert.equal(f.calls.length, 3);
  const receipt = JSON.stringify(f.calls.at(-1));
  assert.match(receipt, /New/); assert.match(receipt, /Last month/); assert.match(receipt, /questionId/);
  process.child.stdin.write('/exit\n');
  assert.equal((await process.result).code, 0);
});

test('real Agent pipe mode stops at permission instead of hanging or granting it', async t => {
  const f = await fixture(t), outside = join(f.root, 'private.txt'); await writeFile(outside, 'NOT_APPROVED');
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const result = await cli(t, ['--prompt', 'read private file'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(result.code, 2, result.stderr); assert.equal(f.calls.length, 1);
  await until(() => f.service.call('chat.jobs'), jobs => jobs[0]?.status === 'stopped');
  assert.doesNotMatch(result.stdout, /NOT_APPROVED/);
});

test('cardbush entry trusts cwd, remembers the connection and resumes without rebinding or copying secrets', async t => {
  const f = await fixture(t), executable = resolve('bin/cardbush.mjs');
  const first = await cli(t, ['--token-file', f.tokenFile, '--prompt', 'current folder'], { env: f.env, cwd: f.cwd, executable }).result;
  assert.equal(first.code, 0, first.stderr);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  const saved = await f.service.call('sessions.get', { sessionId: session.sessionId });
  assert.equal(saved.metadata.runtimeWorkspace.workspaceDir, await realpath(f.cwd));
  assert.equal(JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8')).jobs[0].input.permissionMode,
    'task_free', 'directory trust does not grant full tool access');
  const configText = await readFile(f.env.CARDBUSH_CLI_CONFIG, 'utf8');
  const config = JSON.parse(configText);
  assert.equal(config.tokenFile, f.tokenFile); assert.equal(config.agentId, f.service.info().id);
  assert.doesNotMatch(configText, /fixture-cli-token|fixture-model-secret/);
  assert.doesNotMatch(first.stdout + first.stderr, /\x1b\[/, 'redirected output contains no ANSI');
  const savedEnv = { CARDBUSH_CLI_CONFIG: f.env.CARDBUSH_CLI_CONFIG };
  const other = join(f.root, 'another directory'); await mkdir(other);
  const resumed = await cli(t, ['--resume', session.sessionId, '--prompt', 'continue'], { env: savedEnv, cwd: other, executable }).result;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal((await f.service.call('sessions.get', { sessionId: session.sessionId })).metadata.runtimeWorkspace.workspaceDir, await realpath(f.cwd));
  assert.match(JSON.stringify(f.calls[1].input), /current folder/);
  const next = await cli(t, ['--prompt', 'new cwd'], { env: savedEnv, cwd: other, executable }).result;
  assert.equal(next.code, 0, next.stderr);
  const projects = await f.service.call('projects.list'); assert.equal(projects.projects.length, 2);
  const current = (await f.service.call('sessions.list', { projection: 'summary' })).find(item => item.sessionId !== session.sessionId);
  assert.equal((await f.service.call('sessions.get', { sessionId: current.sessionId })).metadata.runtimeWorkspace.workspaceDir, await realpath(other));
  const listed = await cli(t, ['--projects'], { env: savedEnv, cwd: other, executable }).result;
  assert.equal(listed.code, 0, listed.stderr); assert.match(listed.stdout, /another directory/);
  const denied = await cli(t, ['--url', 'http://127.0.0.1:1', '--models'], { env: savedEnv, executable }).result;
  assert.equal(denied.code, 1); assert.match(denied.stderr, /--token-file/, 'saved token is never reused for another URL');
  assert.equal(await readFile(f.env.CARDBUSH_CLI_CONFIG, 'utf8'), configText, 'ephemeral URL overrides do not overwrite the saved connection');
});

test('local CLI starts without a service or token, owns cwd, resumes and preserves approval modes', async t => {
  const f = await fixture(t), dataRoot = f.service.root;
  await f.stopService();
  const env = { ...await sharedCliEnv(f), CARDBUSH_CLI_CONFIG: join(f.root, 'unused-connection.json') };
  // A leftover CLI-only model file must not compete with App settings.
  await writeFile(join(dataRoot, 'config', 'models.json'), '{"obsolete":true}');
  const first = await cli(t, ['--prompt', 'local current folder'], { env, cwd: f.cwd }).result;
  assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout, 'fixture-answer-1\n');
  let state = JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8'));
  const sessionId = state.jobs[0].sessionId;
  assert.equal(state.projects[0].path, await realpath(f.cwd));
  assert.equal(state.jobs[0].input.permissionMode, 'task_free');
  assert.match(first.stderr, new RegExp(`cardbush --resume ${sessionId}`));
  await assert.rejects(readFile(join(dataRoot, 'access-token')), { code: 'ENOENT' });
  await assert.rejects(readFile(env.CARDBUSH_CLI_CONFIG), { code: 'ENOENT' });
  await localStopped(dataRoot);
  const other = join(f.root, 'other'); await mkdir(other);
  const resumed = await cli(t, ['--resume', sessionId, '--full-access', '--prompt', 'local continuation'], { env, cwd: other }).result;
  assert.equal(resumed.code, 0, resumed.stderr);
  state = JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8'));
  assert.equal(state.projects.length, 1, 'resume never rebinds to the new terminal cwd');
  assert.equal(state.jobs.at(-1).input.permissionMode, 'all_free');
  assert.match(JSON.stringify(f.calls.at(-1).input), /local current folder/);
  // An explicit local invocation ignores a stale remote config and env token.
  await writeFile(env.CARDBUSH_CLI_CONFIG, 'not valid JSON');
  const local = await cli(t, ['--local', '--prompt', 'local again'], { env: { ...env, CARDBUSH_AGENT_URL: 'http://127.0.0.1:1', CARDBUSH_AGENT_TOKEN: 'never-send-me' }, cwd: f.cwd }).result;
  assert.equal(local.code, 0, local.stderr);
  state = JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.at(-1).input.permissionMode, 'task_free');
  assert.doesNotMatch(first.stdout + first.stderr + resumed.stdout + resumed.stderr + local.stdout + local.stderr, /fixture-model-secret|never-send-me/);
});

test('local CLI shares desktop model and Skill settings without adopting desktop Runtime state', async t => {
  const f = await fixture(t); await f.stopService();
  const profile = join(f.root, 'desktop-profile'), dataRoot = join(f.root, 'local-agent');
  await mkdir(join(profile, 'product-host', 'config'), { recursive: true });
  const modelText = await readFile(join(f.service.root, 'config', 'models.json'), 'utf8');
  await writeFile(join(profile, 'product-host', 'config', 'models.json'), modelText);
  await mkdir(join(profile, 'runtime-state'), { recursive: true });
  await writeFile(join(profile, 'runtime-state', 'sentinel'), 'DESKTOP_STATE');
  const skillRoot = join(profile, 'skills', 'fixture-local'); await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: fixture-local\ndescription: Local profile skill fixture\n---\nUse the fixture local profile.\n');
  const env = { CARDBUSH_CLI_DATA_DIR: dataRoot, CARDBUSH_CLI_PROFILE_DIR: profile };
  const local = await cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => local.stderr, text => text.includes('❯ '));
  local.child.stdin.write('/exit\n');
  const result = await local.result;
  assert.equal(result.code, 0, result.stderr); assert.equal(f.calls.length, 0, 'idle startup never calls a model');
  assert.equal(await readFile(join(profile, 'product-host', 'config', 'models.json'), 'utf8'), modelText);
  assert.equal(await readFile(join(profile, 'runtime-state', 'sentinel'), 'utf8'), 'DESKTOP_STATE');
  await assert.rejects(readFile(join(profile, 'agent.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dataRoot, 'config', 'models.json')), { code: 'ENOENT' });
  await localStopped(dataRoot);
  const service = await AgentService.open({ dataRoot, local: true, localProfileRoot: profile });
  try {
    const catalog = await service.call('conversation.catalog', {});
    assert.match(JSON.stringify(catalog), /fixture-local/);
  } finally { await service.close(); }
});

test('local CLI keeps workspace permissions, shares its Runtime, and releases the final client', async t => {
  const f = await fixture(t), dataRoot = f.service.root; await f.stopService();
  const env = await sharedCliEnv(f);
  const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'DO_NOT_PRINT');
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const denied = await cli(t, ['--prompt', 'read outside'], { env, cwd: f.cwd }).result;
  assert.equal(denied.code, 2, denied.stderr); assert.doesNotMatch(denied.stdout, /DO_NOT_PRINT/);
  const terminal = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => terminal.stderr, text => text.includes('❯ '));
  const duplicate = await cli(t, ['--models'], { env, cwd: f.cwd }).result;
  assert.equal(duplicate.code, 0, duplicate.stderr); assert.match(duplicate.stdout, /fixture/);
  terminal.child.stdin.write('\x03');
  const stopped = await terminal.result; assert.equal(stopped.code, 130, stopped.stderr);
  await localStopped(dataRoot);
  const next = await cli(t, ['--models'], { env, cwd: f.cwd }).result;
  assert.equal(next.code, 0, next.stderr);
});

test('simultaneous local windows share one host, run independent sessions, and fork with serialized turns', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f);
  const a = cli(t, [], { env, cwd: f.cwd, interactive: true });
  const b = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await Promise.all([a, b].map(window => until(() => window.stderr, text => text.includes('❯ '), 30000)));
  const client = await localClient(env);
  const owner = await readFile(join(f.service.root, 'agent.lock'), 'utf8');
  assert.notEqual(Number(owner), a.child.pid); assert.notEqual(Number(owner), b.child.pid);
  assert.equal((await client.call('projects.list', {})).projects.length, 1, 'concurrent cwd registration is idempotent');
  assert.equal((await client.call('sessions.list', { projection: 'summary' })).length, 2);
  f.block(true);
  a.child.stdin.write('window alpha\n'); await until(() => f.calls.length, n => n === 1);
  b.child.stdin.write('window beta\n'); await until(() => f.calls.length, n => n === 2);
  const jobs = await client.call('chat.jobs', {});
  const alpha = jobs.find(job => job.text === 'window alpha'), beta = jobs.find(job => job.text === 'window beta');
  assert.notEqual(alpha.sessionId, beta.sessionId);
  assert.equal(alpha.status, 'running'); assert.equal(beta.status, 'running');
  assert.match(JSON.stringify(f.calls[1].input), /workspace_agents/);
  assert.ok(JSON.stringify(f.calls[1].input).includes(alpha.sessionId), 'peer discovery reaches another CLI window');
  a.child.stdin.write('\x03');
  await until(() => client.call('chat.jobs', { sessionId: alpha.sessionId }), rows => rows[0].status === 'stopped');
  await until(() => a.stderr, text => /Stopped/.test(text));
  a.child.stdin.write('/exit\n'); assert.equal((await a.result).code, 0);
  assert.equal((await client.call('chat.jobs', { sessionId: beta.sessionId }))[0].status, 'running');
  assert.equal(await readFile(join(f.service.root, 'agent.lock'), 'utf8'), owner, 'closing the launcher preserves the shared host');
  f.release(); await until(() => b.combined, text => text.includes('fixture-answer-2'));
  await until(() => client.call('chat.jobs', { sessionId: beta.sessionId }), rows => rows[0].status === 'completed');
  const forked = await client.call('sessions.fork', { sessionId: beta.sessionId });
  assert.notEqual(forked.sessionId, beta.sessionId);
  assert.equal(forked.metadata.forkSourceSessionId, beta.sessionId);
  assert.equal(forked.turns.length, 1);
  assert.equal(forked.metadata.runtimeWorkspace.workspaceDir, await realpath(f.cwd));
  f.block(true);
  const send = index => client.call('chat.send', { requestId: `fork-${index}`, sessionId: forked.sessionId,
    turnId: `fork-turn-${index}`, text: `fork request ${index}`, modelId: 'fixture', permissionMode: 'task_free', language: 'en' });
  await Promise.all([send(1), send(2)]);
  await until(() => f.calls.length, n => n === 3);
  const queued = await client.call('chat.jobs', { sessionId: forked.sessionId });
  assert.deepEqual(queued.map(job => job.status).sort(), ['queued', 'running']);
  f.release();
  await until(() => client.call('chat.jobs', { sessionId: forked.sessionId }), rows => rows.every(job => job.status === 'completed'));
  assert.equal(f.calls.length, 4, 'the queued turn executes once after its predecessor');
  b.child.stdin.write('/exit\n'); assert.equal((await b.result).code, 0);
  await client.close(); await localStopped(f.service.root);
});

test('local host survives an abruptly lost client, rejects a different profile, and resumes after idle shutdown', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f);
  const a = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => a.stderr, text => text.includes('❯ '), 30000);
  const client = await localClient(env);
  const pid = await readFile(join(f.service.root, 'agent.lock'), 'utf8');
  await assert.rejects(openLocalChatClient({ dataRoot: f.service.root, profileRoot: join(f.root, 'different-profile') }), /different profile/);
  f.block(true); a.child.stdin.write('finish after disconnect\n'); await until(() => f.calls.length, n => n === 1);
  const sessionId = (await client.call('chat.jobs', {}))[0].sessionId;
  a.child.kill(); await a.result; await client.close();
  await delay(1500);
  assert.equal(await readFile(join(f.service.root, 'agent.lock'), 'utf8'), pid, 'active work keeps the last disconnected host alive');
  f.release(); await localStopped(f.service.root);
  const resumed = await cli(t, ['--resume', sessionId, '--prompt', 'continue saved history'], { env, cwd: f.cwd }).result;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(f.calls.length, 2, 'reconnection never replays the prior submitted task');
  assert.match(JSON.stringify(f.calls[1].input), /finish after disconnect/);
});

test('private local IPC rejects unauthenticated clients and recovers saved sessions after a host crash', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f);
  const client = await localClient(env);
  const project = await client.call('projects.save', { name: 'crash recovery', path: f.cwd });
  const session = await client.call('sessions.create', { projectId: project.id });
  const descriptor = JSON.parse(await readFile(join(f.service.root, 'local-runtime', 'host.json'), 'utf8'));
  const status = headers => new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: descriptor.endpoint, path: '/api/agent/v1/local/lease', headers }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(await status({}), 401);
  assert.equal(await status({ Authorization: `Bearer ${descriptor.token}`, Origin: 'http://untrusted.example' }), 401);
  // Kill only the dedicated host this fixture created. The CLI must recover
  // its stale PID lock without deleting saved sessions or replaying tasks.
  process.kill(descriptor.pid, 'SIGKILL');
  await client.close();
  await until(() => { try { process.kill(descriptor.pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; return false; } }, value => !value);
  const [recovered, peer] = await Promise.all([localClient(env), localClient(env)]);
  const next = JSON.parse(await readFile(join(f.service.root, 'local-runtime', 'host.json'), 'utf8'));
  assert.notEqual(next.pid, descriptor.pid); assert.notEqual(next.token, descriptor.token);
  assert.equal((await recovered.info()).id, (await recovered.call('info', {})).id);
  assert.equal((await recovered.call('sessions.get', { sessionId: session.sessionId })).sessionId, session.sessionId);
  assert.equal((await peer.call('sessions.get', { sessionId: session.sessionId })).sessionId, session.sessionId);
  assert.deepEqual(await recovered.call('chat.jobs', {}), []);
  await recovered.close(); await peer.close();
});

test('the same local CLI reconnects after a Runtime crash without replaying its interrupted task', { timeout: 90000 }, async t => {
  let window, env, finished = false;
  t.after(async () => {
    if (window?.child.exitCode === null) window.child.kill();
    if (!finished && env) { const client = await localClient(env); await client.close(); }
  });
  const f = await fixture(t); await f.stopService(); env = await sharedCliEnv(f);
  f.block(true);
  window = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => window.stderr, text => text.includes('❯ '), 30000);
  window.child.stdin.write('interrupted original task\r'); await until(() => f.calls.length, count => count === 1);
  const original = JSON.parse(await readFile(join(f.service.root, 'local-runtime', 'host.json'), 'utf8'));
  process.kill(original.pid, 'SIGKILL');
  await until(() => window.stderr, text => text.includes('Reconnect to this task?'));
  assert.equal(window.child.exitCode, null); window.child.stdin.write('\r');
  await until(() => window.stderr, text => text.includes('· Interrupted ·'), 30000);
  const next = JSON.parse(await readFile(join(f.service.root, 'local-runtime', 'host.json'), 'utf8'));
  assert.notEqual(next.pid, original.pid); assert.equal(next.agentId, original.agentId);
  assert.equal(f.calls.length, 1, 'reconnect never resubmits the interrupted request');
  f.release(); window.child.stdin.write('new task after reconnect\r');
  await until(() => window.stderr, text => text.includes('✓ Completed ·'));
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.deepEqual(state.jobs.map(job => job.status), ['interrupted', 'completed']);
  assert.equal(f.calls.length, 2);
  window.child.stdin.write('/exit\r'); assert.equal((await window.result).code, 0);
  await localStopped(f.service.root);
  finished = true;
});

test('concurrent local reconnects share one lease and closing cannot revive a connection', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f), client = await localClient(env);
  const identity = (await client.info()).id;
  const first = client.reconnect(), second = client.reconnect();
  assert.equal(first, second); await Promise.all([first, second]);
  assert.equal((await client.info()).id, identity); assert.deepEqual(await client.call('chat.jobs', {}), []);
  const reconnecting = client.reconnect(); await client.close(); await reconnecting;
  await assert.rejects(client.reconnect(), /closed/);
  await localStopped(f.service.root);
  assert.equal(f.calls.length, 0);
});

test('shared local sessions exchange room messages and retain stale-file protection', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f);
  const client = await localClient(env);
  const run = async (text, sessionId) => {
    const result = await cli(t, [...(sessionId ? ['--resume', sessionId] : []), '--prompt', text], { env, cwd: f.cwd }).result;
    assert.equal(result.code, 0, result.stderr);
    return (await client.call('chat.jobs', {})).find(job => job.text === text);
  };
  f.tools({ name: 'get_tool_schema', arguments: { name: 'agentchatroom' } },
    { name: 'call_tool', arguments: { name: 'agentchatroom', arguments: { action: 'join' } } });
  const a = await run('alpha joins room');
  f.tools({ name: 'get_tool_schema', arguments: { name: 'agentchatroom' } },
    { name: 'call_tool', arguments: { name: 'agentchatroom', arguments: { action: 'join' } } });
  const b = await run('beta joins room');
  const executions = await client.call('runtime.command', { kind: 'runtime.list_turn_tool_executions', payload: { sessionId: a.sessionId, turnId: a.turnId } });
  assert.match(JSON.stringify(executions), /call_tool/);
  // Use the actual returned room identity from the provider's tool receipts.
  const receipts = f.calls.flatMap(call => call.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output).join('\n');
  const roomId = /"room_id"\s*:\s*"([^"\\]+)"/.exec(receipts)?.[1];
  assert.ok(roomId, receipts);
  f.tools({ name: 'call_tool', arguments: { name: 'agentchatroom', arguments: { action: 'send', room_id: roomId,
    text: 'Alpha edits the shared file; beta handles tests.', client_message_id: 'cli-test-message' } } });
  await run('alpha sends assignment', a.sessionId);
  f.tools({ name: 'call_tool', arguments: { name: 'agentchatroom', arguments: { action: 'read', room_id: roomId } } });
  await run('beta reads assignment', b.sessionId);
  assert.match(JSON.stringify(f.calls.at(-1).input), /Alpha edits the shared file; beta handles tests/);
  const file = join(f.cwd, 'shared.txt'); await writeFile(file, 'original');
  f.setTool({ name: 'read_file', arguments: { path: file } }); await run('alpha observes file', a.sessionId);
  await writeFile(file, 'changed by another editor');
  f.setTool({ name: 'write_file', arguments: { path: file, content: 'stale overwrite' } });
  await run('alpha attempts stale write', a.sessionId);
  assert.equal(await readFile(file, 'utf8'), 'changed by another editor');
  assert.match(JSON.stringify(f.calls.at(-1).input.filter(item => item.type === 'function_call_output')), /workspace_revision_not_observed/);
  await client.close();
});

test('late noisy MCP diagnostics never overwrite a local draft, hide tool failures or pollute pipe output', async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f);
  const trigger = join(f.root, 'emit-logs'), logPath = join(f.service.root, 'logs', 'runtime.log');
  await writeFile(join(env.CARDBUSH_CLI_PROFILE_DIR, 'product-host', 'config', 'mcp-servers.json'), JSON.stringify({
    protocol: 'cardbush.product_mcp_config.v1', revision: 1, servers: [{ id: 'noisy_fixture', enabled: true,
      transport: 'stdio', command: process.execPath, args: [resolve('scripts/helpers/agent-chat-cli-noisy-mcp.mjs')], env: { FIXTURE_LOG_TRIGGER: trigger } }],
  }));
  const local = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => local.stderr, text => text.includes('❯ '));
  await until(() => readFile(logPath, 'utf8').catch(() => ''), text => text.includes('unsupported server/discover'));
  local.child.stdin.write('preserved draft');
  await writeFile(trigger, 'go');
  await until(() => readFile(logPath, 'utf8'), text => text.includes('late-fixture-log 99'));
  assert.equal(f.calls.length, 0, 'background logs do not submit the partial draft');
  assert.doesNotMatch(local.stderr + local.stdout, /runtime_browser_connection|runtime_mcp_|fixture startup|late-fixture-log|server\/discover/);
  f.setTool({ name: 'read_file', arguments: { path: join(f.cwd, 'missing-file.txt') } });
  local.child.stdin.write(' completed\n');
  await until(() => local.stderr, text => text.includes('1 failed') && text.includes('✓ Completed'));
  assert.match(local.stderr, /1 failed · \/tools/, 'structured task failures remain visible in the compact group');
  assert.doesNotMatch(local.stderr, /\[Tool failed\]/, 'errors no longer dump into the interactive transcript');
  const modelCalls = f.calls.length;
  local.child.stdin.write('/tools\n');
  await until(() => local.stderr, text => text.includes('Tools from this turn'));
  assert.match(local.stderr, /1\. read_file · Failed/);
  local.child.stdin.write('/tools 1\n');
  await until(() => local.stderr, text => text.includes('missing-file.txt'));
  assert.equal(f.calls.length, modelCalls, 'inspection must not submit another task');
  local.child.stdin.write('/logs\n');
  await until(() => local.stderr, text => text.includes(logPath));
  local.child.stdin.write('/exit\n');
  const result = await local.result; assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].input.text, 'preserved draft completed');
  const piped = await cli(t, [], { env, cwd: f.cwd, input: 'one piped message' }).result;
  assert.equal(piped.code, 0, piped.stderr); assert.match(piped.stdout, /^fixture-answer-\d+\n$/);
  assert.doesNotMatch(piped.stdout + piped.stderr, /runtime_browser_connection|runtime_mcp_|fixture startup|late-fixture-log|server\/discover/);
});

test('native model/settings commands share App JSON, preserve secrets, and recover after a provider failure', async t => {
  const f = await fixture(t); await f.stopService(); const env = await sharedCliEnv(f);
  const configPath = join(env.CARDBUSH_CLI_PROFILE_DIR, 'product-host', 'config', 'models.json');
  const original = JSON.parse(await readFile(configPath, 'utf8'));
  const local = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => local.stderr, text => text.includes('❯ '));
  assert.match(local.stderr, /fixture-model · Approval mode/); assert.ok(local.stderr.includes(f.cwd));
  // Editing the same App file is visible without creating/replacing any CLI config.
  const updated = { ...original, defaultModelId: 'second', models: [...original.models, { ...original.models[0], id: 'second', model: 'second-model' }] };
  const sharedText = JSON.stringify(updated, null, 2); await writeFile(configPath, sharedText);
  local.child.stdin.write('/settings\n');
  await until(() => local.stderr, text => text.includes('Save, then press Enter to reload'));
  assert.ok(local.stderr.includes(configPath)); assert.match(local.stderr, /JSON settings shared with CardBush App/);
  local.child.stdin.write('\n');
  await until(() => local.stderr, text => text.includes('second-model · Approval mode'));
  assert.equal(f.calls.length, 0, 'settings and model selection never call a provider');
  local.child.stdin.write('/model\n');
  await until(() => local.stderr, text => text.includes('Select a number or model ID'));
  local.child.stdin.write('1\n');
  await until(() => local.stderr, text => text.includes('Select Reasoning Level for fixture-model'));
  local.child.stdin.write('high\n');
  await until(() => local.stderr, text => text.includes('Switched to: fixture-model'));
  f.failNext('OFFLINE_PROVIDER_REJECTED'); local.child.stdin.write('failing turn\n');
  await until(() => local.stderr, text => text.includes('[Error]') && text.includes('! Task failed ·'));
  assert.equal(local.child.exitCode, null, 'a provider error returns to the prompt');
  local.child.stdin.write('/model second\n');
  await until(() => local.stderr, text => text.includes('Select Reasoning Level for second-model'));
  local.child.stdin.write('default\n');
  await until(() => local.stderr, text => text.includes('Switched to: second-model'));
  local.child.stdin.write('successful turn\n');
  await until(() => local.combined, text => text.includes('fixture-answer-2'));
  await until(() => local.stderr, text => (text.match(/(?:✓ Completed|! Task failed) ·/g) ?? []).length >= 2);
  local.child.stdin.write('/exit\n');
  const result = await local.result; assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(call => call.model), ['fixture-model', 'second-model']);
  assert.deepEqual(f.calls.map(call => call.reasoning?.effort), ['high', undefined], 'provider default clears any shared setting');
  assert.equal(await readFile(configPath, 'utf8'), sharedText, 'model switching does not rewrite App defaults or credentials');
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-model-secret|\x1b\[\?1049[hl]/);
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.deepEqual(state.jobs.map(job => job.input.text), ['failing turn', 'successful turn']);
  assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'completed']);
  assert.deepEqual(state.jobs.map(job => job.input.reasoningEffort), ['high', null]);
  const resumed = await cli(t, ['--resume', state.jobs.at(-1).sessionId, '--prompt', 'resume with chosen effort'], { env, cwd: f.cwd }).result;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(f.calls.at(-1).model, 'second-model'); assert.equal(f.calls.at(-1).reasoning?.effort, undefined);
  assert.equal(await readFile(configPath, 'utf8'), sharedText, 'resume does not change shared settings');
});

test('unconfigured local CLI waits for file editing, reloads in place and never submits setup input', async t => {
  const f = await fixture(t); await f.stopService();
  const dataRoot = join(f.root, 'unconfigured'), profile = join(f.root, 'no-desktop'), configPath = join(profile, 'product-host', 'config', 'models.json');
  const env = { CARDBUSH_CLI_DATA_DIR: dataRoot, CARDBUSH_CLI_PROFILE_DIR: profile };
  const local = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => local.stderr, text => text.includes('Save, then press Enter to reload'));
  assert.ok(local.stderr.includes(configPath)); assert.doesNotMatch(local.stderr, /❯ /);
  assert.equal(f.calls.length, 0);
  const template = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(template.version, 1); assert.ok(template._comment); assert.ok(template.models[0]._comment.apiProtocol);
  assert.doesNotMatch(JSON.stringify(template), /\p{Script=Han}/u, 'generated configuration guidance is English');
  assert.equal(template.models[0].apiKey, ''); assert.equal(template.models[0].model, '');
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'product-host', 'config', 'models.example.json'), 'utf8')), template);
  // Parsing errors may contain fragments of a secret in Node's native message.
  const broken = '{"apiKey":"DO_NOT_ECHO_SECRET", invalid}';
  await writeFile(configPath, broken);
  local.child.stdin.write('\n');
  await until(() => local.stderr, text => text.includes('Invalid model configuration'));
  assert.equal(await readFile(configPath, 'utf8'), broken, 'retry does not overwrite user edits');
  assert.doesNotMatch(local.stderr, /DO_NOT_ECHO_SECRET/);
  assert.equal(f.calls.length, 0);
  const configured = JSON.parse(await readFile(join(f.service.root, 'config', 'models.json'), 'utf8'));
  Object.assign(template.models[0], configured.models[0], { id: 'default' });
  await writeFile(configPath, JSON.stringify(template));
  local.child.stdin.write('\n');
  await until(() => local.stderr, text => text.includes('❯ '));
  assert.equal(f.calls.length, 0, 'configuration does not make a test request to the provider');
  local.child.stdin.write('actual conversation\n');
  await until(() => local.combined, text => text.includes('fixture-answer-1'));
  await until(() => local.stderr, text => text.includes('✓ Completed'));
  local.child.stdin.write('/exit\n');
  const result = await local.result; assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls.length, 1);
  const state = JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].input.text, 'actual conversation');
  assert.equal(state.projects[0].path, await realpath(f.cwd));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-model-secret|DO_NOT_ECHO_SECRET/);
});

// Five consecutive cold Runtime starts include Windows sandbox/plugin startup
// and idle shutdown. Each individual wait remains bounded by until().
test('empty or malformed local configuration preserves edits, exits pipes promptly, and can cancel setup', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.stopService();
  const dataRoot = join(f.root, 'empty-models'), profile = join(f.root, 'no-desktop'), configPath = join(profile, 'product-host', 'config', 'models.json');
  await mkdir(join(profile, 'product-host', 'config'), { recursive: true });
  const content = '{"version":1,"defaultModelId":"","models":[],"_comment":"KEEP_MY_NOTE"}';
  await writeFile(configPath, content);
  const env = { CARDBUSH_CLI_DATA_DIR: dataRoot, CARDBUSH_CLI_PROFILE_DIR: profile };
  const pipe = await cli(t, ['--prompt', 'do not send this before configuration'], { env, cwd: f.cwd }).result;
  assert.equal(pipe.code, 2, pipe.stderr); assert.ok(pipe.stderr.includes(configPath));
  assert.equal(await readFile(configPath, 'utf8'), content); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8')).jobs.length, 0);
  await writeFile(configPath, '{"apiKey":"PRIVATE_CONFIG", broken}');
  for (const command of ['/q\r', '/quit\r', '/exit\r', '\x03']) {
    const local = cli(t, [], { env, cwd: f.cwd, interactive: true });
    await until(() => local.stderr, text => text.includes('Save, then press Enter to reload'));
    assert.doesNotMatch(local.stderr, /PRIVATE_CONFIG/);
    local.child.stdin.write(command);
    assert.equal((await local.result).code, command === '\x03' ? 130 : 0);
    await localStopped(dataRoot);
    assert.match(await readFile(configPath, 'utf8'), /PRIVATE_CONFIG/);
    assert.equal(JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8')).jobs.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('full-access is explicit per launch; idle Ctrl+C prints a blue resume ID without an alternate screen', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.txt'); await writeFile(outside, 'FULL_ACCESS_FILE');
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const full = await cli(t, ['--full-access', '--prompt', 'read outside'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(full.code, 0, full.stderr); assert.match(JSON.stringify(f.calls[1].input), /FULL_ACCESS_FILE/);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  assert.equal(JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8')).jobs[0].input.permissionMode, 'all_free');
  const child = cli(t, ['--resume', session.sessionId], { env: { ...f.env, NO_COLOR: undefined, TERM: 'xterm' }, cwd: f.cwd, interactive: true });
  await until(() => child.stderr, text => text.includes('❯ '));
  assert.match(child.stderr, /Approval mode/, 'resuming defaults to approval, not the previous full-access launch');
  child.child.stdin.write('\x03');
  const result = await child.result;
  assert.equal(result.code, 130, result.stderr);
  assert.ok(result.stderr.endsWith(`cardbush --resume \x1b[34m${session.sessionId}\x1b[0m\n`));
  assert.equal(f.calls.length, 2, 'resume and idle Ctrl+C do not submit another task');
});

test('HTTP calls can be cancelled and abrupt event disconnects become recoverable network errors', async t => {
  const calls = []; let response;
  const http = createServer((req, res) => {
    calls.push(req.url); response = res;
    if (req.url.includes('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-cardbush-agent-id': 'fixture' });
      res.write(`data: ${JSON.stringify({ type: 'ready', agentId: 'fixture' })}\n\n`);
    }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const client = new AgentHttpClient(`http://127.0.0.1:${http.address().port}/`, 'fixture-token', 'fixture');
  t.after(async () => { client.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const abort = new AbortController(); const pending = client.call('chat.jobs', {}, abort.signal);
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await until(() => calls.length, length => length === 1); abort.abort(); await rejected;
  const events = client.events({ sessionId: 's', turnId: 't' }, new AbortController().signal);
  assert.equal((await events.next()).value.type, 'ready');
  response.destroy(); await assert.rejects(events.next(), AgentNetworkError);
  assert.equal(calls.length, 2, 'client does not repeat commands on its own');
});
