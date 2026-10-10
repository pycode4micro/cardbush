import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolRegistry,
  registerExtendedBuiltins,
  RuntimeToolLoop, InMemoryRuntimeEventLog, ToolExecutionStore,
} from "../dist/index.js";

test("publishes one strict archived-result reader", async () => {
  const registry = new ToolRegistry();
  const archived = {
    protocol: "bush.tool_result.v1",
    output: { text: "x".repeat(2_000) },
  };
  registerExtendedBuiltins(registry, {
    readToolResult(locator) {
      assert.equal(locator, "tool-result://session/turn/call");
      return archived;
    },
  });

  const reader = registry.resolve("read_archived_tool_result");
  assert.ok(reader);
  assert.deepEqual(reader.definition.inputSchema.required, ["locator"]);
  assert.equal(reader.definition.inputSchema.additionalProperties, false);

  assert.throws(
    () => reader.decodeInput({ locator: "C:\\Users\\fixture\\SKILL.md" }),
    /exact tool-result:\/\//,
  );
  assert.throws(
    () => reader.decodeInput({ locator: "file:///tmp/not-an-archive" }),
    /exact tool-result:\/\//,
  );

  const input = reader.decodeInput({
    locator: "tool-result://session/turn/call",
    offset: 500,
    max_chars: 500,
  });
  const result = await reader.execute(context(input));
  assert.equal(result.locator, "tool-result://session/turn/call");
  assert.equal(result.offset, 500);
  assert.equal(result.text.length, 500);
  assert.equal(result.complete, false);
});

const decodePage = content => {
  const marker = '\n\n[text]\n', at = content.indexOf(marker);
  assert.ok(at >= 0, 'reader returns a page rather than an archive of that page');
  return { ...JSON.parse(content.slice(0, at)), text: content.slice(at + marker.length) };
};

test('oversized reads deliver contiguous pages with truthful completion and preserve Unicode', async () => {
  const source = '中文😀"\\\n'.repeat(8000), registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { readToolResultText: () => source });
  const store = new ToolExecutionStore();
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  let offset = 0, reconstructed = '', round = 0;
  do {
    const call = { protocol: 'bush.tool_call.v1', id: 'read-' + ++round, name: 'read_archived_tool_result',
      argumentsText: JSON.stringify({ locator: 'tool-result://s/t/original', offset, max_chars: 50000 }) };
    const result = await loop.execute([call], { round, assistantMessageId: 'a' + round });
    assert.ok(result.messages[0].content.length <= 16000);
    const page = decodePage(result.messages[0].content);
    assert.equal(page.archived, undefined);
    assert.equal(page.locator, 'tool-result://s/t/original');
    assert.equal(page.offset, offset); assert.equal(page.next_offset, offset + page.text.length);
    assert.ok(page.next_offset > offset); assert.equal(page.complete, page.next_offset === source.length);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
    reconstructed += page.text; offset = page.next_offset;
    assert.ok(round < 20);
  } while (offset < source.length);
  assert.equal(reconstructed, source);
  assert.ok(store.get('s', 't', 'read-1').result.text.length > 16000, 'native evidence remains intact');
});

test('parallel readers share the final ingress budget without skipping archive content', async () => {
  const registry = new ToolRegistry(); registerExtendedBuiltins(registry, { readToolResultText: () => 'x'.repeat(4000) });
  const loop = new RuntimeToolLoop({ registry, eventLog: new InMemoryRuntimeEventLog(), identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  const calls = [0, 1].map(i => ({ protocol: 'bush.tool_call.v1', id: 'read-' + i, name: 'read_archived_tool_result',
    argumentsText: JSON.stringify({ locator: 'tool-result://s/t/source-' + i, max_chars: 50000 }) }));
  const result = await loop.execute(calls, { round: 1, assistantMessageId: 'a', modelContextIngressBudgetTokens: 2000 });
  assert.ok(result.messages.reduce((n, m) => n + m.content.length, 0) <= 2000);
  for (const message of result.messages) {
    const page = decodePage(message.content);
    assert.equal(page.complete, false); assert.equal(page.next_offset, page.text.length); assert.ok(page.next_offset > 0);
  }
});

test('search truncation keeps whole hits and resumes at the first omitted hit', async () => {
  const source = Array.from({ length: 20 }, (_, i) => 'x'.repeat(180) + 'needle-' + i).join('\n');
  const registry = new ToolRegistry(); registerExtendedBuiltins(registry, { readToolResultText: () => source });
  const loop = new RuntimeToolLoop({ registry, eventLog: new InMemoryRuntimeEventLog(), identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  let offset = 0, round = 0; const offsets = [];
  while (true) {
    const call = { protocol: 'bush.tool_call.v1', id: 'search-' + ++round, name: 'read_archived_tool_result',
      argumentsText: JSON.stringify({ locator: 'tool-result://s/t/source', query: 'needle', offset, max_chars: 50000, limit: 50 }) };
    const result = await loop.execute([call], { round, assistantMessageId: 'a' + round, modelContextIngressBudgetTokens: 1800 });
    const page = JSON.parse(result.messages[0].content);
    assert.equal(page.archived, undefined); assert.ok(page.matches.length > 0);
    for (const match of page.matches) { assert.equal(source.slice(match.offset, match.end_offset), 'needle'); offsets.push(match.offset); }
    if (page.complete) break;
    assert.ok(page.next_offset > offset); offset = page.next_offset; assert.ok(round < 25);
  }
  assert.equal(offsets.length, 20); assert.equal(new Set(offsets).size, 20);
});

function context(input) {
  return {
    requestId: "request_archive",
    sessionId: "session",
    turnId: "turn",
    toolCall: {
      protocol: "bush.tool_call.v1",
      id: "call_reader",
      name: "read_archived_tool_result",
      argumentsText: JSON.stringify(input),
    },
    input,
    actionManifest: {
      protocol: "bush.tool.action_manifest.v1",
      manifest_id: "manifest_archive",
      effect_kind: "observation",
      operation: "tool_result_archive.read",
      risk: "low",
      owner: "runtime",
      dispatch_scope: "session",
      mutating: false,
    },
    capabilityIds: [],
    recordWorkspaceChange() {},
  };
}
