import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeChatCompletionChunk, resolveLocalImageInputs, toChatCompletionCreateParams } from "../dist/index.js";

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

test("forwards explicit output and reasoning controls without adding local defaults", () => {
  const base = {
    protocol: "bush.model_request.v1",
    requestId: "request",
    sessionId: "session",
    turnId: "turn",
    model: "model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: "auto",
    metadata: {},
  };
  const providerDefault = toChatCompletionCreateParams(base);
  assert.equal(providerDefault.max_completion_tokens, undefined);
  assert.equal(providerDefault.reasoning_effort, undefined);
  const explicit = toChatCompletionCreateParams({
    ...base,
    maxOutputTokens: 32768,
    reasoningEffort: "xhigh",
  });
  assert.equal(explicit.max_completion_tokens, 32768);
  assert.equal(explicit.reasoning_effort, "xhigh");
});

test("projects the internal developer role to universally compatible system messages", () => {
  const request = toChatCompletionCreateParams({
    protocol: "bush.model_request.v1",
    requestId: "request_developer",
    sessionId: "session_developer",
    turnId: "turn_developer",
    model: "compatible-model",
    messages: [
      { role: "system", content: "stable prefix" },
      { role: "developer", name: "runtime_protocol", content: "declare the outcome" },
      { role: "user", content: "hello" },
    ],
    tools: [],
    toolChoice: "auto",
    metadata: {},
  });

  assert.deepEqual(request.messages.map((message) => message.role), ["system", "system", "user"]);
  assert.equal(request.messages[1].name, "runtime_protocol");
  assert.equal(request.messages[1].content, "declare the outcome");
});

test("projects explicit image inputs without inferring them from text", () => {
  const request = toChatCompletionCreateParams({
    protocol: "bush.model_request.v1",
    requestId: "request_image",
    sessionId: "session_image",
    turnId: "turn_image",
    model: "vision-model",
    messages: [{
      role: "user",
      content: "inspect this",
      images: [{ url: "data:image/png;base64,aGVsbG8=", detail: "high" }],
    }],
    tools: [],
    toolChoice: "auto",
    metadata: {},
  });
  assert.deepEqual(request.messages[0].content, [
    { type: "text", text: "inspect this" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" },
    },
  ]);
});

test("validates and resolves an explicit local image path before provider submission", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bush-provider-image-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "image.png");
  await writeFile(path, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  const request = await resolveLocalImageInputs({
    protocol: "bush.model_request.v1",
    requestId: "request_local_image",
    sessionId: "session_local_image",
    turnId: "turn_local_image",
    model: "vision-model",
    messages: [{ role: "user", content: "inspect", images: [{ url: path }] }],
    tools: [],
    toolChoice: "auto",
    metadata: {},
  });
  assert.match(request.messages[0].images[0].url, /^data:image\/png;base64,/);
  const textPath = join(root, "not-image.txt");
  await writeFile(textPath, "not an image", "utf8");
  await assert.rejects(() => resolveLocalImageInputs({
    ...request,
    messages: [{ role: "user", content: "inspect", images: [{ url: textPath }] }],
  }), /supported raster image/);
});
