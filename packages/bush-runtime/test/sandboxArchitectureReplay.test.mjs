import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ToolExecutionCoordinator, ToolRegistry, registerSkillTools, registerWorkspaceTools, TerminalSessionManager } from '../dist/index.js';
import { getProcessResourceGovernor } from '../dist/processes.js';

// Sanitized replay of observed tool order and failure mechanisms. No original
// user files, paths, messages, credentials, or live move commands are replayed.
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cardbush-architecture-replay-')));
  const work = join(root, 'workspace'), skill = join(root, 'skills', 'example'), outside = join(root, 'desktop-fixture');
  for (const path of [work, join(skill, 'references'), join(skill, 'scripts'), outside]) mkdirSync(path, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: example\ndescription: Replay example skill\n---\nRead references/style.md.');
  writeFileSync(join(skill, 'references/style.md'), 'example style');
  writeFileSync(join(skill, 'scripts/run.js'), 'not a documentation grant');
  writeFileSync(join(outside, 'secret.txt'), 'outside secret');
  writeFileSync(join(work, 'sample.txt'), 'replay needle');
  const registry = new ToolRegistry(), terminals = new TerminalSessionManager();
  let activeRoots = [skill], answer = 'deny', ordinal = 0, beforeRun;
  const prompts = [];
  registerSkillTools(registry, () => activeRoots);
  registerWorkspaceTools(registry, undefined, { terminals });
  const coordinator = new ToolExecutionCoordinator({ registry,
    observer: { running() { const action = beforeRun; beforeRun = undefined; action?.(); } },
    permissions: { async request(request) { prompts.push(request); return { decision: answer, grantedCapabilityIds: answer === 'allow_once' ? request.capabilityIds : [] }; } },
  });
  const metadata = { workspaceDir: work };
  const turn = { request: { protocol: 'bush.model_request.v1', requestId: 'replay', sessionId: 'replay', turnId: 'turn', model: 'fixture', tools: registry.definitions(), messages: [], permissionMode: 'task_free', metadata }, contextMessages: [] };
  const run = (name, input) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `replay-${++ordinal}`, name, argumentsText: JSON.stringify(input) },
    { requestId: 'replay', sessionId: 'replay', turnId: 'turn', round: 1, ordinal }, undefined, turn);
  t.after(async () => { await terminals.close(); assert.equal(dirname(root), realpathSync.native(tmpdir())); await rmSync(root, { recursive: true, force: true }); });
  return { work, skill, outside, registry, terminals, run, prompts, metadata,
    allowOnce() { answer = 'allow_once'; }, deny() { answer = 'deny'; }, disableProvider() { activeRoots = []; }, beforeRun(action) { beforeRun = action; } };
}

test('session 095c replay: directory diagnosis, discovered skill read, one-time authorized move', { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const directory = await f.run('read_file', { path: f.work });
  assert.equal(directory.error?.code, 'EISDIR', JSON.stringify(directory));
  assert.match(directory.error.message, /directory/);
  const skills = await f.run('search_skills', { query: '*' });
  assert.equal(skills.result.matches[0].mainResource, join(f.skill, 'SKILL.md'));
  const read = await f.run('read_file', { path: skills.result.matches[0].mainResource, environment: 'local' });
  assert.equal(read.kind, 'returned', JSON.stringify(read));
  assert.match(read.result.content, /references\/style.md/);
  assert.equal((await f.run('read_file', { path: join(f.skill, 'references/style.md') })).kind, 'returned');
  assert.equal(f.prompts.length, 0, 'published Skill instructions must not ask again');
  const locations = await f.run('get_user_directories', {});
  assert.equal(locations.result.accessGranted, false);
  assert.equal(locations.result.executionEnvironment.kind, 'local');
  const source = join(f.work, 'artifact.html'), target = join(f.outside, 'artifact.html');
  assert.equal((await f.run('write_file', { path: source, content: '<html>fixture</html>' })).kind, 'returned');
  await f.run('read_file', { path: source });
  f.allowOnce();
  const moved = await f.run('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${target}\n@@\n-<html>fixture</html>\n+<html>fixture</html>\n*** End Patch` });
  assert.equal(moved.kind, 'returned', JSON.stringify(moved));
  assert.equal(f.prompts.length, 1); assert.equal(existsSync(source), false);
  assert.equal(readFileSync(target, 'utf8').trim(), '<html>fixture</html>');
  f.deny();
  assert.equal((await f.run('read_file', { path: target })).error.code, 'permission_rejected');
  assert.equal(f.prompts.length, 2, 'allow once must not widen subsequent access');
});

test('Skill grants reject scripts, writes, disabled resources and escaping links', { timeout: 20_000 }, async t => {
  const f = fixture(t), main = join(f.skill, 'SKILL.md');
  for (const [name, input] of [
    ['read_file', { path: join(f.skill, 'scripts/run.js') }],
    ['write_file', { path: main, content: 'changed' }],
    ['search_file_content', { path: f.skill, query: 'secret' }],
  ]) assert.equal((await f.run(name, input)).error.code, 'permission_rejected');
  const alias = join(f.skill, 'references', 'escape');
  symlinkSync(f.outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.run('read_file', { path: join(alias, 'secret.txt') })).error.code, 'permission_rejected');
  f.metadata.disabledSkills = ['example'];
  assert.equal((await f.run('read_file', { path: main })).error.code, 'permission_rejected');
  delete f.metadata.disabledSkills; f.metadata.allowedSkills = [];
  assert.equal((await f.run('read_file', { path: main })).error.code, 'permission_rejected');
  delete f.metadata.allowedSkills; f.disableProvider();
  assert.equal((await f.run('read_file', { path: main })).error.code, 'permission_rejected');
});

test('session 8700 replay: saturated terminal slots leave bounded file and search progress', { timeout: 45_000 }, async t => {
  const f = fixture(t), governor = getProcessResourceGovernor(), previous = { ...governor.limits };
  Object.assign(governor.limits, { maxConcurrentTasks: 2, startupMemoryBytes: 1024 ** 2 });
  const leases = [governor.acquire(), governor.acquire()];
  t.after(() => { leases.forEach(lease => lease.release()); Object.assign(governor.limits, previous); });
  assert.throws(() => governor.acquire(), { code: 'resource_capacity_busy' });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => i % 2
    ? f.run('read_file', { path: join(f.work, 'sample.txt') })
    : f.run('search_file_content', { path: f.work, query: 'needle' })));
  for (const result of results) { assert.equal(result.kind, 'returned', JSON.stringify(result)); assert.match(result.result.content ?? result.result.output, /needle/); }
  assert.equal(f.prompts.length, 0);
});

test('an automatic Skill resource grant remains bound to the admitted directory identity', async t => {
  const f = fixture(t);
  writeFileSync(join(f.outside, 'SKILL.md'), 'unapproved replacement');
  f.beforeRun(() => { renameSync(f.skill, f.skill + '-old'); symlinkSync(f.outside, f.skill, process.platform === 'win32' ? 'junction' : 'dir'); });
  const result = await f.run('read_file', { path: join(f.skill, 'SKILL.md') });
  assert.equal(result.error.code, 'workspace_authorization_changed'); assert.equal(result.result, undefined); assert.equal(f.prompts.length, 0);
});

test('session 8700 replay: stopping an exited terminal collects output without approval', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const started = await f.terminals.start({ ownerSessionId: 'replay', cwd: f.work, shell: process.platform === 'win32' ? 'cmd' : 'posix',
    command: process.platform === 'win32' ? 'set /p value= & echo finished' : 'read value; echo finished', yieldTimeMs: 1,
    sandbox: { writableRoots: [f.work], network: 'disabled' } });
  assert.equal(started.state, 'running');
  const rejected = await f.run('terminal_stop', { session_id: started.terminalSessionId });
  assert.equal(rejected.error?.code, 'permission_rejected', JSON.stringify(rejected));
  await f.terminals.write('replay', { sessionId: started.terminalSessionId, chars: '\n', yieldTimeMs: 1 });
  for (let n = 0; n < 200 && f.terminals.describe('replay', started.terminalSessionId).state === 'running'; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(f.terminals.describe('replay', started.terminalSessionId).state, 'running');
  const stopped = await f.run('terminal_stop', { session_id: started.terminalSessionId });
  assert.equal(stopped.kind, 'returned', JSON.stringify(stopped)); assert.equal(f.prompts.length, 1);
});
