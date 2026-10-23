import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { followAgentTurn, stopAgentTurn, resumeHint, terminalText } from '../dist-electron/agentChatCli.mjs';
import { AgentHttpClient, AgentNetworkError } from '../dist-electron/agentHttpClient.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { localDesktopProfile } from '../dist-electron/agentLocalChat.mjs';
import { chatShellCommand, chatShellInvocation, runChatShell } from '../dist-electron/agentChatShell.mjs';
import { waitForChatConfiguration } from '../dist-electron/agentChatModels.mjs';

const entry = resolve('dist-electron/agentChatCli.mjs');
const tempRoot = resolve('tmp/agent-chat-cli-tests');
const job = { id: 'job', sessionId: 'session', turnId: 'turn' };
const segment = { messageId: 'message', segmentId: 'segment', ordinal: 0 };
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
      if (operation === 'chat.jobs') return [{ ...job, status, error: status === 'failed' ? 'Fixture task failed' : undefined }];
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

test('answered approvals and resolved questions are skipped on replay', async () => {
  const client = clientFixture([
    event('permission_requested', 1, permission),
    event('permission_answered', 2, { permissionId: permission.permissionId, answerId: 'answered', decision: 'deny', grantedCapabilityIds: [] }),
    event('solution_selection_requested', 3, question),
  ], { pending: false }), io = terminal();
  await followAgentTurn(client, job, io, new AbortController().signal);
  assert.deepEqual(io.questions, []); assert.ok(client.calls.every(call => !call.input.kind?.startsWith('runtime.answer')));
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
  const state = { child, stdout: '', stderr: '', result: undefined };
  child.stdout.setEncoding('utf8').on('data', text => { state.stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { state.stderr += text; });
  child.stdin.on('error', () => {});
  state.result = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout: state.stdout, stderr: state.stderr })); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  if (!interactive) child.stdin.end(input);
  return state;
}

test('CLI help and argument errors do not need a server or credentials', async t => {
  const help = await cli(t, ['--help']).result;
  assert.equal(help.code, 0); assert.match(help.stdout, /cardbush --resume/); assert.match(help.stdout, /--full-access/);
  assert.match(help.stdout, /Usage: cardbush/); assert.doesNotMatch(help.stdout, /\p{Script=Han}/u);
  assert.match(help.stdout, /\/quit \(or \/exit\) exits/);
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
  let nextTool, nextFailure, nextText, blocked = false; const calls = [], pending = new Set();
  const release = () => { blocked = false; for (const finish of pending) finish(); pending.clear(); };
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 })); return; }
    calls.push(body); const index = calls.length;
    if (nextFailure) { const message = nextFailure; nextFailure = undefined; res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'invalid_request_error' } })); return; }
    const selected = nextTool; nextTool = undefined;
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
  return { root, cwd, service, calls, env, tokenFile, release, setText: text => { nextText = text; }, setTool: tool => { nextTool = tool; }, block: value => { blocked = value; }, failNext: message => { nextFailure = message; },
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

test('CLI native commands stay local, return to chat and ignore child Ctrl+C without submitting model work', async t => {
  const f = await fixture(t), log = join(f.root, 'shell.jsonl');
  const process = cli(t, [], { env: { ...f.env, CARDBUSH_TEST_SHELL_LOG: log }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
  for (const [index, command] of ['/shell vim "a file.txt"', '!echo done', '/shell'].entries()) {
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

test('queued CLI prompts appear once in turn order after the preceding completion', async t => {
  const f = await fixture(t); f.block(true);
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('❯ '));
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
  const visible = stripVTControlCharacters(result.stderr);
  assert.match(visible, /❯ first ordering question[\s\S]*✓ Completed[\s\S]*❯ second ordering question[\s\S]*✓ Completed[\s\S]*❯ third ordering question[\s\S]*✓ Completed/);
  for (const prefix of ['first', 'second', 'third']) assert.equal(visible.split(`❯ ${prefix} ordering question`).length, 2, 'each prompt is committed exactly once');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(stripVTControlCharacters(result.stdout).trim().split(/\s+/), ['fixture-answer-1', 'fixture-answer-2', 'fixture-answer-3']);
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
  f.block(false); process.child.stdin.write('/steer use the existing files\r');
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
  await until(() => process.stderr, text => text.includes('[y/N]'));
  assert.equal(f.calls.length, 1); process.child.stdin.write('y\n');
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'completed');
  assert.match(JSON.stringify(f.calls[1]), /APPROVED_FILE/);
  f.setTool({ name: 'solution_selection', arguments: { prompt: 'Pick a scope', options: ['First', 'Second'] } });
  process.child.stdin.write('choose scope\n');
  await until(() => process.stderr, text => text.includes('/cancel'));
  process.child.stdin.write('2\n');
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
  f.setTool({ name: 'solution_selection', arguments: { questions: multiQuestion.questions } });
  process.child.stdin.write('ask two questions\n');
  await until(() => process.stderr, text => text.includes('[1/2] Which version?') && text.includes('/cancel'));
  process.child.stdin.write('2\n');
  await until(() => process.stderr, text => text.includes('[2/2] Which period?'));
  assert.equal(f.calls.length, 1, 'provider has no partial answers');
  process.child.stdin.write('Last month\n');
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'completed');
  assert.equal(f.calls.length, 2);
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
  await assert.rejects(readFile(join(dataRoot, 'agent.lock')), { code: 'ENOENT' });
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
  const service = await AgentService.open({ dataRoot, local: true, localProfileRoot: profile });
  try {
    const catalog = await service.call('conversation.catalog', {});
    assert.match(JSON.stringify(catalog), /fixture-local/);
  } finally { await service.close(); }
});

test('local CLI keeps workspace permissions, handles Ctrl+C, and releases its ownership lock', async t => {
  const f = await fixture(t), dataRoot = f.service.root; await f.stopService();
  const env = await sharedCliEnv(f);
  const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'DO_NOT_PRINT');
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const denied = await cli(t, ['--prompt', 'read outside'], { env, cwd: f.cwd }).result;
  assert.equal(denied.code, 2, denied.stderr); assert.doesNotMatch(denied.stdout, /DO_NOT_PRINT/);
  const terminal = cli(t, [], { env, cwd: f.cwd, interactive: true });
  await until(() => terminal.stderr, text => text.includes('❯ '));
  const duplicate = await cli(t, ['--models'], { env, cwd: f.cwd }).result;
  assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /already owns/);
  terminal.child.stdin.write('\x03');
  const stopped = await terminal.result; assert.equal(stopped.code, 130, stopped.stderr);
  await assert.rejects(readFile(join(dataRoot, 'agent.lock')), { code: 'ENOENT' });
  const next = await cli(t, ['--models'], { env, cwd: f.cwd }).result;
  assert.equal(next.code, 0, next.stderr);
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
  await until(() => local.stderr, text => text.includes('[Tool failed]') && text.includes('✓ Completed'));
  assert.match(local.stderr, /\[Tool failed\]/, 'structured task failures remain visible');
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
  await until(() => local.stderr, text => text.includes('Switched to: fixture-model'));
  f.failNext('OFFLINE_PROVIDER_REJECTED'); local.child.stdin.write('failing turn\n');
  await until(() => local.stderr, text => text.includes('[Error]') && text.includes('! Task failed ·'));
  assert.equal(local.child.exitCode, null, 'a provider error returns to the prompt');
  local.child.stdin.write('/model second\n');
  await until(() => local.stderr, text => text.includes('Switched to: second-model'));
  local.child.stdin.write('successful turn\n');
  await until(() => local.stdout, text => text.includes('fixture-answer-2'));
  await until(() => local.stderr, text => (text.match(/(?:✓ Completed|! Task failed) ·/g) ?? []).length >= 2);
  local.child.stdin.write('/exit\n');
  const result = await local.result; assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(call => call.model), ['fixture-model', 'second-model']);
  assert.equal(await readFile(configPath, 'utf8'), sharedText, 'model switching does not rewrite App defaults or credentials');
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-model-secret|\x1b\[\?1049[hl]/);
  const state = JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8'));
  assert.deepEqual(state.jobs.map(job => job.input.text), ['failing turn', 'successful turn']);
  assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'completed']);
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
  await until(() => local.stdout, text => text.includes('fixture-answer-1'));
  await until(() => local.stderr, text => text.includes('✓ Completed'));
  local.child.stdin.write('/exit\n');
  const result = await local.result; assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls.length, 1);
  const state = JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].input.text, 'actual conversation');
  assert.equal(state.projects[0].path, await realpath(f.cwd));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-model-secret|DO_NOT_ECHO_SECRET/);
});

test('empty or malformed local configuration preserves edits, exits pipes promptly, and can cancel setup', async t => {
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
    await assert.rejects(readFile(join(dataRoot, 'agent.lock')), { code: 'ENOENT' });
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
