// Explicit, single-request diagnostic. Reads journals; never resumes a Turn or executes tools.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { OpenAIResponsesProvider } from '@cardbush/bush-provider-openai';

const sessionId = process.argv[2];
if (!/^local-[a-f0-9-]+$/i.test(sessionId ?? '')) throw new Error('Usage: node scripts/probe-provider-session.mjs <local-session-id> [--send]');
const dataRoot = resolve(process.env.CARDBUSH_PROBE_PROFILE || join(process.env.APPDATA, 'cardbush'));
const digest = value => createHash('sha256').update(value).digest('hex');
const journalPath = join(dataRoot, 'runtime-state', 'sessions', digest(sessionId) + '.jsonl');
const originalJournal = await readFile(journalPath, 'utf8');
const events = originalJournal.trim().split(/\r?\n/).map(line => {
  const record = JSON.parse(line);
  assert.equal(record.checksum, digest(JSON.stringify(record.event)), 'journal checksum');
  return record.event;
});
const turn = events.filter(event => event.kind === 'turn_committed').at(-1)?.payload;
assert.ok(turn && turn.cacheChainState, 'No committed Turn with a cache snapshot.');
// Do not silently misrepresent a reconstructed multi-Turn or compacted projection as exact.
assert.equal(events.filter(event => event.kind === 'turn_committed').length, 1, 'This probe currently supports a single original Turn only.');
const metadata = events.find(event => event.kind === 'session_created').payload.metadata;
const projectDir = metadata.projectDir || metadata.project_dir;
const config = JSON.parse(await readFile(join(dataRoot, 'product-host', 'config', 'models.json'), 'utf8'));
const model = config.models.find(model => model.id === config.defaultModelId);
assert.ok(model?.apiKey && model?.model, 'Configured model is missing.');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'cardbush-provider-probe-'));
const registry = new ToolRegistry();
const host = new InMemoryRuntimeHost({
  dataRoot: temporaryRoot, toolRegistry: registry,
  provider: { async *stream() { throw new Error('Probe must not execute the Runtime loop'); } },
});
const fetchImpl = globalThis.fetch;
try {
  const user = turn.messages.find(entry => entry.message.role === 'user' && entry.message.visibility !== 'internal');
  const seed = createProductAgentTurnRequest({
    requestId: 'probe-' + randomUUID(), sessionId, turnId: turn.turnId,
    messageId: user.messageId, createdAt: user.createdAt, localDate: user.createdAt.slice(0, 10),
    userText: user.message.content, model: model.model, projectDir, workspaceDir: projectDir,
    filesystemLocations: ['Home', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music']
      .map(name => ({ id: name.toLowerCase(), name, path: name === 'Home' ? homedir() : join(homedir(), name) }))
      .filter(location => existsSync(location.path)),
    permissionMode: 'task_free', planEnabled: true, visionEnabled: true,
    tools: registry.definitions().filter(tool => !['request_permission', 'update_goal'].includes(tool.name)),
    maxOutputTokens: model.maxOutputTokens || 8192, maxContextTokens: model.maxContextTokens,
    reasoningEffort: 'high',
  });
  const messages = [...seed.prefixMessages, ...turn.messages.map(({ message }) => message.role === 'tool'
    ? { role: 'tool', toolCallId: message.toolCallId, content: message.content } : message)];
  const expected = turn.cacheChainState.messageDigests;
  const mismatches = messages.flatMap((message, index) => digest(JSON.stringify(message)) === expected[index] ? [] : [index]);
  console.log(JSON.stringify({
    probe: 'saved-context', sessionId, turnId: turn.turnId, originalStatus: turn.status,
    model: model.model, messageCount: messages.length, originalMessageCount: expected.length,
    messageDigestMismatches: mismatches, tools: seed.tools.length, maxOutputTokens: seed.maxOutputTokens,
    toolDefinitions: 'current built-in catalog; original dynamic MCP catalog is not persisted',
    sendsRequest: process.argv.includes('--send'), executesTools: false,
  }));
  assert.equal(messages.length, expected.length, 'Incomplete message reconstruction');
  assert.deepEqual(mismatches, [], 'Refusing to send a nonmatching saved message context');
  if (process.argv.includes('--send')) {
    const network = [];
    const causeSummary = error => {
      const chain = [], seen = new Set();
      for (let cause = error; cause && typeof cause === 'object' && !seen.has(cause) && chain.length < 6; cause = cause.cause) {
        seen.add(cause);
        chain.push({
          name: cause.constructor?.name || cause.name,
          code: typeof cause.code === 'string' ? cause.code : undefined,
          // Credentials and model text are intentionally excluded.
          message: ['fetch failed', 'terminated', 'other side closed', 'Connection error.'].includes(cause.message) ? cause.message : undefined,
        });
      }
      return chain;
    };
    globalThis.fetch = async (...args) => {
      const start = Date.now();
      try {
        const response = await fetchImpl(...args);
        network.push({ elapsedMs: Date.now() - start, status: response.status });
        return response;
      } catch (error) {
        network.push({ elapsedMs: Date.now() - start, causes: causeSummary(error) });
        throw error;
      }
    };
    const provider = new OpenAIResponsesProvider({
      apiKey: model.apiKey, baseURL: model.baseURL, timeoutMs: 90_000,
    });
    const request = {
      protocol: 'bush.model_request.v1', requestId: seed.requestId,
      sessionId: 'isolated-probe-' + randomUUID(), turnId: 'probe-' + randomUUID(),
      model: seed.model, messages, tools: seed.tools, maxOutputTokens: seed.maxOutputTokens,
      reasoningEffort: seed.reasoningEffort, requestCapabilities: seed.requestCapabilities,
      permissionMode: seed.permissionMode, metadata: {},
    };
    const start = Date.now();
    let terminal, usage, textChars = 0, reasoningChars = 0;
    const toolNames = new Set();
    for await (const event of provider.stream(request, { signal: AbortSignal.timeout(95_000) })) {
      if (event.kind === 'usage') usage = event;
      if (event.kind === 'text_delta') textChars += event.delta.length;
      if (event.kind === 'reasoning_delta') reasoningChars += event.delta.length;
      if (event.kind === 'tool_call_delta' && event.nameDelta) toolNames.add(event.nameDelta);
      if (['response_failed', 'response_completed'].includes(event.kind)) terminal = event;
    }
    console.log(JSON.stringify({ elapsedMs: Date.now() - start, network, terminal, usage, textChars, reasoningChars, proposedToolsNotExecuted: [...toolNames] }));
  }
} finally {
  globalThis.fetch = fetchImpl;
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  await rm(temporaryRoot, { recursive: true, force: true }); // exact mkdtemp directory owned by this probe
  assert.equal(await readFile(journalPath, 'utf8'), originalJournal, 'Probe must not change original session facts');
}
