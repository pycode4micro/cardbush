import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { followAgentTurn, resumeHint, terminalText } from '../dist-electron/agentChatCli.mjs';
import { AgentHttpClient, AgentNetworkError } from '../dist-electron/agentHttpClient.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';

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
  assert.equal(resumeHint('session-123', true), '\n继续此会话：cardbush resume \x1b[34msession-123\x1b[0m\n');
  assert.equal(resumeHint('\x1b[2Jsession-123', false), '\n继续此会话：cardbush resume session-123\n');
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
  const bootstrap = `process.stdin.isTTY = process.stderr.isTTY = true;
    const { main } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    try { process.exitCode = await main(process.argv.slice(1)); }
    catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }`;
  const child = spawn(process.execPath, interactive ? ['--input-type=module', '-e', bootstrap, '--', ...args] : [executable, ...args],
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
  assert.equal(help.code, 0); assert.match(help.stdout, /cardbush resume/); assert.match(help.stdout, /--full-access/);
  const invalid = await cli(t, ['--permission', 'invalid']).result;
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /Invalid --permission/);
  const missing = await cli(t, ['--prompt', 'test']).result;
  assert.equal(missing.code, 1); assert.match(missing.stderr, /--token-file/);
  for (const args of [['resume'], ['resume', 's', 'extra'], ['unknown'], ['resume', 's', '--session', 's'],
    ['resume', 's', '--project', 'p'], ['--full-access', '--permission', 'task_free']]) {
    assert.equal((await cli(t, args).result).code, 1, JSON.stringify(args));
  }
});

async function fixture(t) {
  await mkdir(tempRoot, { recursive: true }); const root = await mkdtemp(join(tempRoot, 'case-'));
  let nextTool, blocked = false; const calls = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 })); return; }
    calls.push(body); const index = calls.length;
    const selected = nextTool; nextTool = undefined;
    const text = `fixture-answer-${index}`;
    const item = selected ? { id: `function-${index}`, call_id: `call-${index}`, type: 'function_call', name: selected.name,
      arguments: JSON.stringify(selected.arguments), status: 'completed' }
      : { id: `message-${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const response = { id: `response-${index}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    if (blocked) return;
    emit(selected ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
      : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }); res.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  let service, http;
  t.after(async () => {
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
  return { root, cwd, service, calls, env, tokenFile, setTool: tool => { nextTool = tool; }, block: value => { blocked = value; } };
}

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
  assert.match(one.stderr, new RegExp(`cardbush resume ${sessionId}`));
  const piped = await cli(t, ['--session', sessionId], { env: f.env, input: 'line one\n第二行\n' }).result;
  assert.equal(piped.code, 0, piped.stderr); assert.equal(piped.stdout, 'fixture-answer-2\n');
  const saved = await f.service.call('sessions.get', { sessionId }); assert.equal(saved.turns.length, 2);
  assert.match(JSON.stringify(f.calls[1].input), /first instruction/); assert.match(JSON.stringify(f.calls[1].input), /第二行/);
  const listed = await cli(t, ['--sessions'], { env: f.env }).result; assert.match(listed.stdout, new RegExp(sessionId));
  const invalid = await cli(t, ['--model', 'missing', '--prompt', 'not sent'], { env: f.env }).result;
  assert.equal(invalid.code, 1); assert.equal(f.calls.length, 2);
  const large = await cli(t, [], { env: f.env, input: '中'.repeat(750000) }).result;
  assert.equal(large.code, 1); assert.match(large.stderr, /过大/); assert.equal(f.calls.length, 2);
  assert.deepEqual(await f.service.call('product.command', { kind: 'models.get' }), before);
  assert.doesNotMatch([models, one, piped, listed, invalid].map(result => result.stdout + result.stderr).join('\n'), /fixture-model-secret|fixture-cli-token/);
});

test('real Agent and native readline: approval, question, multiple turns and Ctrl+C stop', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.txt'); await writeFile(outside, 'APPROVED_FILE');
  const process = cli(t, [], { env: { ...f.env, NO_COLOR: '', TERM: 'xterm' }, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('你> '));
  f.setTool({ name: 'read_file', arguments: { path: outside } }); process.child.stdin.write('read file\n');
  await until(() => process.stderr, text => text.includes('[y/N]'));
  assert.equal(f.calls.length, 1); process.child.stdin.write('y\n');
  await until(() => process.stderr, text => text.split('你> ').length >= 3);
  assert.match(JSON.stringify(f.calls[1]), /APPROVED_FILE/);
  f.setTool({ name: 'solution_selection', arguments: { prompt: 'Pick a scope', options: ['First', 'Second'] } });
  process.child.stdin.write('choose scope\n');
  await until(() => process.stderr, text => text.includes('/cancel'));
  process.child.stdin.write('2\n');
  await until(() => process.stderr, text => text.split('你> ').length >= 4);
  assert.match(JSON.stringify(f.calls.at(-1)), /Second/);
  f.block(true); const previous = f.calls.length; process.child.stdin.write('long task\n');
  await until(() => f.calls.length, count => count > previous);
  process.child.stdin.write('\x03');
  await until(() => process.stderr, text => text.includes('已请求停止'));
  await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'stopped');
  f.block(false); process.child.stdin.write('/exit\n');
  const result = await process.result; assert.equal(result.code, 0, result.stderr);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  assert.ok(result.stderr.endsWith(`继续此会话：cardbush resume ${session.sessionId}\n`), 'NO_COLOR and normal exit preserve a copyable resume command');
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[\?1049[hl]/, 'never enters an alternate terminal screen');
  assert.equal(f.calls.length, previous + 1, 'Ctrl+C must not resubmit the task');
});

test('real Agent and native readline submit all question answers to the offline provider together', async t => {
  const f = await fixture(t);
  const process = cli(t, [], { env: f.env, cwd: f.cwd, interactive: true });
  await until(() => process.stderr, text => text.includes('你> '));
  f.setTool({ name: 'solution_selection', arguments: { questions: multiQuestion.questions } });
  process.child.stdin.write('ask two questions\n');
  await until(() => process.stderr, text => text.includes('[1/2] Which version?') && text.includes('/cancel'));
  process.child.stdin.write('2\n');
  await until(() => process.stderr, text => text.includes('[2/2] Which period?'));
  assert.equal(f.calls.length, 1, 'provider has no partial answers');
  process.child.stdin.write('Last month\n');
  await until(() => process.stderr, text => text.split('你> ').length >= 3);
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
  const resumed = await cli(t, ['resume', session.sessionId, '--prompt', 'continue'], { env: savedEnv, cwd: other, executable }).result;
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

test('full-access is explicit per launch; idle Ctrl+C prints a blue resume ID without an alternate screen', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.txt'); await writeFile(outside, 'FULL_ACCESS_FILE');
  f.setTool({ name: 'read_file', arguments: { path: outside } });
  const full = await cli(t, ['--full-access', '--prompt', 'read outside'], { env: f.env, cwd: f.cwd }).result;
  assert.equal(full.code, 0, full.stderr); assert.match(JSON.stringify(f.calls[1].input), /FULL_ACCESS_FILE/);
  const session = (await f.service.call('sessions.list', { projection: 'summary' }))[0];
  assert.equal(JSON.parse(await readFile(join(f.service.root, 'agent.json'), 'utf8')).jobs[0].input.permissionMode, 'all_free');
  const child = cli(t, ['resume', session.sessionId], { env: { ...f.env, NO_COLOR: undefined, TERM: 'xterm' }, cwd: f.cwd, interactive: true });
  await until(() => child.stderr, text => text.includes('你> '));
  assert.match(child.stderr, /申请审批/, 'resuming defaults to approval, not the previous full-access launch');
  child.child.stdin.write('\x03');
  const result = await child.result;
  assert.equal(result.code, 130, result.stderr);
  assert.ok(result.stderr.endsWith(`cardbush resume \x1b[34m${session.sessionId}\x1b[0m\n`));
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
