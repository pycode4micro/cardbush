import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeResponseStreamEvent,
  OpenAIResponsesProvider,
  resolveLocalImageInputs,
  toResponsesCreateParams,
} from "../dist/index.js";

function response(overrides = {}) {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1787932800,
    model: "compatible-model",
    status: "completed",
    output: [],
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tools: [],
    top_p: null,
    usage: null,
    ...overrides,
  };
}

test("normalizes Responses text, reasoning, function calls and cache usage", () => {
  const state = { requestId: "req_1", sequence: 0, started: false };
  const providerEvents = [
    {
      type: "response.created",
      sequence_number: 0,
      response: response({ status: "in_progress" }),
    },
    {
      type: "response.reasoning_text.delta",
      sequence_number: 1,
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      delta: "inspect first",
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "checking",
      logprobs: [],
    },
    {
      type: "response.output_item.added",
      sequence_number: 3,
      output_index: 2,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "open_page",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 4,
      output_index: 2,
      item_id: "fc_1",
      delta: '{"url":',
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 5,
      output_index: 2,
      item_id: "fc_1",
      name: "open_page",
      arguments: '{"url":"https://example.com"}',
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: response({
        output: [{
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "open_page",
          arguments: '{"url":"https://example.com"}',
          status: "completed",
        }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 7 },
        },
      }),
    },
  ];

  const events = providerEvents.flatMap((event) =>
    normalizeResponseStreamEvent(event, state),
  );
  assert.deepEqual(events.map((event) => event.kind), [
    "response_started",
    "reasoning_delta",
    "text_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "usage",
    "response_completed",
  ]);
  assert.equal(events[3].toolCallId, "call_1");
  assert.equal(events[3].nameDelta, "open_page");
  assert.equal(
    events.filter((event) => event.kind === "tool_call_delta")
      .map((event) => event.argumentsDelta ?? "")
      .join(""),
    '{"url":"https://example.com"}',
  );
  assert.equal(events.find((event) => event.kind === "usage")?.cachedInputTokens, 80);
  assert.equal(events.at(-1).finishReason, "tool_calls");
});

test("keeps sequence stable and ignores events after a terminal Response", () => {
  const state = { requestId: "req_2", sequence: 0, started: false };
  const first = normalizeResponseStreamEvent({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "a",
    logprobs: [],
  }, state);
  const terminal = normalizeResponseStreamEvent({
    type: "response.completed",
    sequence_number: 2,
    response: response(),
  }, state);
  const ignored = normalizeResponseStreamEvent({
    type: "response.output_text.delta",
    sequence_number: 3,
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "late",
    logprobs: [],
  }, state);
  assert.deepEqual([...first, ...terminal].map((event) => event.sequence), [0, 1, 2]);
  assert.deepEqual(ignored, []);
});

test("projects Bush messages into stateless Responses input items", () => {
  const request = toResponsesCreateParams({
    protocol: "bush.model_request.v1",
    requestId: "request_projection",
    sessionId: "session_projection",
    turnId: "turn_projection",
    model: "deepseek-v4-flash-vision-exp",
    messages: [
      { role: "developer", name: "runtime_protocol", content: "declare the outcome" },
      {
        role: "user",
        content: "inspect this",
        images: [{ url: "data:image/png;base64,aGVsbG8=", detail: "high" }],
      },
      {
        role: "assistant",
        content: "I will inspect it.",
        reasoningContent: "Use the browser tool.",
        toolCalls: [{ id: "call_1", name: "open_page", argumentsText: '{"url":"https://example.com"}' }],
      },
      { role: "tool", content: "opened", toolCallId: "call_1" },
    ],
    tools: [{
      name: "open_page",
      description: "Open a page",
      inputSchema: { type: "object" },
    }],
    reasoningEffort: "high",
    metadata: {},
  });

  assert.equal(request.store, false);
  assert.equal("tool_choice" in request, false);
  assert.deepEqual(request.reasoning, { effort: "high" });
  assert.deepEqual(request.tools[0], {
    type: "function",
    name: "open_page",
    description: "Open a page",
    parameters: { type: "object" },
    strict: false,
  });
  assert.deepEqual(request.input.map((item) => item.type), [
    "message",
    "message",
    "reasoning",
    "message",
    "function_call",
    "function_call_output",
  ]);
  assert.equal(request.input[0].role, "developer");
  assert.equal(request.input[0].content, "[runtime_protocol]\ndeclare the outcome");
  assert.deepEqual(request.input[1].content[1], {
    type: "input_image",
    image_url: "data:image/png;base64,aGVsbG8=",
    detail: "high",
  });
  assert.equal(request.input[4].call_id, "call_1");
  assert.equal(request.input[5].call_id, "call_1");
});

test("maps all six product reasoning levels to Responses reasoning effort", () => {
  const base = {
    protocol: "bush.model_request.v1",
    requestId: "request_reasoning",
    sessionId: "session_reasoning",
    turnId: "turn_reasoning",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    metadata: {},
  };
  for (const reasoningEffort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    const request = toResponsesCreateParams({ ...base, reasoningEffort });
    assert.deepEqual(request.reasoning, { effort: reasoningEffort });
  }
});

test("omits unsupported tool_choice without dropping the Tool catalog", () => {
  const request = toResponsesCreateParams({
    protocol: "bush.model_request.v1",
    requestId: "request_no_tools",
    sessionId: "session_no_tools",
    turnId: "turn_no_tools",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "answer directly" }],
    tools: [{ name: "open_page", inputSchema: { type: "object" } }],
    metadata: {},
  });
  assert.equal("tool_choice" in request, false);
  assert.equal(request.tools.length, 1);
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

test("posts directly to the Responses endpoint and streams stable model events", async (context) => {
  let received;
  const server = createServer(async (request, responseStream) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    responseStream.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of [
      {
        type: "response.created",
        sequence_number: 0,
        response: response({ status: "in_progress" }),
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "hello",
        logprobs: [],
      },
      {
        type: "response.completed",
        sequence_number: 2,
        response: response(),
      },
    ]) {
      responseStream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    responseStream.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new OpenAIResponsesProvider({
    apiKey: "response-secret",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  });
  const events = [];
  for await (const event of provider.stream({
    protocol: "bush.model_request.v1",
    requestId: "request_wire",
    sessionId: "session_wire",
    turnId: "turn_wire",
    model: "response-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "open_page", inputSchema: { type: "object" } }],
    reasoningEffort: "high",
    metadata: {},
  })) events.push(event);

  assert.equal(received.method, "POST");
  assert.equal(received.url, "/v1/responses");
  assert.equal(received.authorization, "Bearer response-secret");
  assert.equal(received.body.stream, true);
  assert.equal("tool_choice" in received.body, false);
  assert.deepEqual(received.body.reasoning, { effort: "high" });
  assert.deepEqual(events.map((event) => event.kind), [
    "response_started",
    "text_delta",
    "response_completed",
  ]);
});
