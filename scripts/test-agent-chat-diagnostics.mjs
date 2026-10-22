import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AgentChatDiagnostics } from '../dist-electron/agentChatDiagnostics.mjs';

const base = resolve('tmp/agent-chat-diagnostics-tests');
async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return root;
}

test('diagnostics combine fragmented lines, redact decoded MCP stderr and preserve stream boundaries', async t => {
  const path = join(await fixture(t), 'logs', 'runtime.log'), log = new AgentChatDiagnostics(path);
  const text = JSON.stringify({ code: 'runtime_mcp_stderr', message: '中文 apiKey="PRIVATE_VALUE"\nAuthorization: Bearer PRIVATE_BEARER' }) + '\n';
  log.write('stderr', text.slice(0, 50)); log.write('stdout', 'worker output'); log.write('stderr', text.slice(50));
  log.write('stderr', 'final partial line'); log.close(); log.close(); log.write('stderr', 'after close\n');
  const raw = await readFile(path, 'utf8'), lines = raw.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3); assert.equal(lines[0].stream, 'stderr'); assert.equal(lines[1].stream, 'stdout');
  assert.match(raw, /中文/); assert.match(raw, /redacted/); assert.match(raw, /final partial line/);
  assert.doesNotMatch(raw, /PRIVATE_VALUE|PRIVATE_BEARER|after close/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('unbounded output and file write errors cannot flood or crash the terminal', async t => {
  const root = await fixture(t), log = new AgentChatDiagnostics(join(root, 'runtime.log'));
  log.write('stderr', 'x'.repeat(32_760)); log.write('stderr', 'secret=' + 'private'.repeat(10_000));
  log.write('stderr', '\nhealthy next line\n'); log.close();
  const content = await readFile(log.path, 'utf8');
  assert.ok(content.length < 1000); assert.match(content, /oversized diagnostic line omitted/); assert.match(content, /healthy next line/);
  assert.doesNotMatch(content, /secret|private/);
  const blocked = join(root, 'blocked'); await writeFile(blocked, 'file, not a directory');
  const failed = new AgentChatDiagnostics(join(blocked, 'runtime.log'));
  assert.doesNotThrow(() => { failed.write('stderr', 'sensitive raw diagnostic\n'); failed.write('stderr', 'late log\n'); failed.close(); });
  assert.match(failed.error, /^[A-Z0-9_]+$/);
});
