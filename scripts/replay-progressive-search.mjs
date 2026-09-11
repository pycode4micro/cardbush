// Read recorded discovery facts only. Historical tools and network calls never run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ToolRegistry, registerMcpDiscovery, projectMcpDiscoveryResult } from '@cardbush/bush-runtime';

globalThis.fetch = async () => { throw new Error('Network access is forbidden in this replay.'); };
const sessionId = process.argv[2];
if (!/^local-[a-f0-9-]{36}$/.test(sessionId ?? '')) throw new Error('Pass a local Session ID.');
const output = resolve(process.argv[3] ?? 'tmp/progressive-search-replay.json');
if (!output.startsWith(resolve('.') + sep)) throw new Error('The report must remain in the workspace.');
const hash = value => createHash('sha256').update(value).digest('hex');
const root = join(process.env.APPDATA, 'cardbush', 'runtime-state');
const sourcePaths = ['sessions', 'tool-executions'].map(directory => join(root, directory, hash(sessionId) + '.jsonl'));
const sourceBytes = await Promise.all(sourcePaths.map(path => readFile(path)));
const events = sourceBytes[0].toString().trim().split('\n').map(line => JSON.parse(line).event);
const records = sourceBytes[1].toString().trim().split('\n').map(line => JSON.parse(line).record);
const searches = records.filter(record => record.toolCall.name === 'mcp_search' && record.result?.protocol === 'bush.mcp_discovery.v1');
const originalMessages = new Map(events.filter(event => event.kind === 'turn_committed')
  .flatMap(event => event.payload.messages).filter(item => item.message.role === 'tool')
  .map(item => [item.message.toolCallId, item.message.content]));
const definitions = new Map();
for (const record of searches) for (const match of record.result.matches) {
  if (!match.inputSchema) continue;
  const prior = definitions.get(match.name);
  if (prior) assert.equal(prior.revision, match.revision, 'This replay requires an unchanged recorded catalog.');
  definitions.set(match.name, match);
}
assert.ok(definitions.size, 'No complete recorded definitions are available.');
const registry = new ToolRegistry(); registerMcpDiscovery(registry);
for (const definition of definitions.values()) registry.register({ definition,
  manifest: { effect_kind: 'observation', operation: 'offline.fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
  decodeInput: input => input, execute: () => { throw new Error('Historical tool execution is forbidden.'); },
  mcpHook: { server: definition.server, tool: definition.tool, call: async () => { throw new Error('MCP calls are forbidden.'); } },
});
const search = registry.resolve('mcp_search');
const request = { sessionId, turnId: 'offline', tools: registry.definitions(), metadata: { mcpToolDiscovery: true } };
const rows = [];
for (const record of searches) {
  const args = JSON.parse(record.toolCall.argumentsText);
  const result = await search.execute({ input: search.decodeInput({ ...args, action: 'search', reload: false }), turn: { request, contextMessages: [] } });
  assert.deepEqual(result.matches.map(match => match.name), record.result.matches.map(match => match.name), 'The recorded hit page must be reproduced exactly.');
  assert.ok(result.matches.every(match => !match.inputSchema));
  const projected = projectMcpDiscoveryResult(JSON.stringify(result));
  assert.ok(projected, 'Compact results must fit without truncating their structure.');
  const original = originalMessages.get(record.toolCall.id);
  assert.ok(original, 'A model-visible historical receipt must exist.');
  rows.push({ turnId: record.turnId, toolCallId: record.toolCall.id, matchedNames: result.matches.map(match => match.name),
    originalReceiptChars: original.length, progressiveReceiptChars: projected.length });
}
for (const [index, path] of sourcePaths.entries()) assert.equal(hash(await readFile(path)), hash(sourceBytes[index]));
const totals = rows.reduce((value, row) => ({ before: value.before + row.originalReceiptChars, after: value.after + row.progressiveReceiptChars }), { before: 0, after: 0 });
const report = { sessionId, liveApiCalls: 0, historicalToolsExecuted: 0, sourcesUnchanged: true,
  scope: 'Search receipts only, with exactly the same recorded hit pages. This excludes subsequent explicit loads and is not a prediction of API token savings or cache hit rate. Unrecorded tools are absent from the fixture; global match totals are not compared.',
  rows, totals: { ...totals, reductionPercent: 100 * (1 - totals.after / totals.before) }, sourceHashes: sourceBytes.map(hash) };
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sessionId, searches: rows.length, ...report.totals, sourcesUnchanged: true, output }));
