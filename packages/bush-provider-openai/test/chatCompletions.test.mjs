import assert from "node:assert/strict";
import test from "node:test";

import { normalizeChatCompletionChunk } from "../dist/index.js";

test("normalizes text, reasoning, parallel tool deltas and cache usage", () => {
  const state = { requestId: "req_1", sequence: 0, started: false };
  const events = normalizeChatCompletionChunk(
    {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1787932800,
      model: "compatible-model",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          delta: {
            content: "checking",
            reasoning_content: "inspect first",
            tool_calls: [
              { index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":' } },
              { index: 1, id: "call_b", type: "function", function: { name: "search_file_content", arguments: '{"query":"x"}' } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    },
    state,
  );

  assert.deepEqual(
    events.map((event) => event.kind),
    ["response_started", "text_delta", "reasoning_delta", "tool_call_delta", "tool_call_delta", "usage", "response_completed"],
  );
  assert.equal(events.find((event) => event.kind === "reasoning_delta")?.delta, "inspect first");
  assert.equal(events.find((event) => event.kind === "usage")?.cachedInputTokens, 80);
});

test("keeps sequence stable across chunks", () => {
  const state = { requestId: "req_1", sequence: 0, started: false };
  const first = normalizeChatCompletionChunk(
    {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1787932800,
      model: "compatible-model",
      choices: [{ index: 0, finish_reason: null, delta: { content: "a" } }],
    },
    state,
  );
  const second = normalizeChatCompletionChunk(
    {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1787932800,
      model: "compatible-model",
      choices: [{ index: 0, finish_reason: "stop", delta: { content: "b" } }],
    },
    state,
  );

  assert.deepEqual([...first, ...second].map((event) => event.sequence), [0, 1, 2, 3]);
});
