import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import Anthropic from '@anthropic-ai/sdk';
import { modelEventSchema } from "@cardbush/bush-protocol";
import { providerFailureEvent } from "../dist/providerFailure.js";
import { OpenAIResponsesProvider, normalizeResponseStreamEvent } from "../dist/index.js";

const failure = (error, aborted = false) => modelEventSchema.parse(providerFailureEvent("retry-probe", 0, error, aborted));
const request = {
  protocol: "bush.model_request.v1", requestId: "retry-probe", sessionId: "probe", turnId: "probe",
  model: "fixture-model", messages: [{ role: "user", content: "test" }], tools: [], metadata: {},
};
const cause = (code) => Object.assign(new Error("SENSITIVE: credential URL, body and headers"), { code });

test("retains bounded socket diagnostics through SDK and aggregate causes without raw data", () => {
  const socket = cause("ECONNRESET");
  const aggregate = new AggregateError([socket, cause("ETIMEDOUT")], "SENSITIVE");
  aggregate.cause = aggregate; // cycles must not hang normalization
  const event = failure(new OpenAI.APIConnectionError({
    cause: new TypeError("fetch failed", { cause: aggregate }),
  }));
  assert.equal(event.code, "ECONNRESET");
  assert.equal(event.retryable, true);
  assert.equal(event.diagnostics.errorName, "APIConnectionError");
  assert.deepEqual(event.diagnostics.causeNames, ["TypeError", "AggregateError", "Error"]);
  assert.deepEqual(event.diagnostics.causeCodes, ["ECONNRESET", "ETIMEDOUT"]);
  assert.doesNotMatch(JSON.stringify(event), /SENSITIVE|credential|headers|stack/);
});

test("retries network failures and timeouts, not invalid connection configuration", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT"]) {
    assert.equal(failure(new TypeError("terminated", { cause: cause(code) })).retryable, true, code);
  }
  const timeout = failure(new OpenAI.APIConnectionTimeoutError());
  assert.equal(timeout.code, "provider_timeout");
  assert.equal(timeout.retryable, true);
  assert.equal(failure(new OpenAI.APIConnectionError({})).code, "provider_connection_error");
  for (const code of ["ERR_INVALID_URL", "UND_ERR_INVALID_ARG", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    const event = failure(new OpenAI.APIConnectionError({ cause: cause(code) }));
    assert.equal(event.retryable, false, code);
    assert.equal(event.code, code);
  }
  assert.equal(failure(new Error("local programming error")).retryable, false);
  assert.equal(failure(new OpenAI.APIConnectionError({}), true).code, "request_aborted");
  assert.equal(failure(new OpenAI.APIUserAbortError()).retryable, false);
});

test("HTTP retry policy respects Retry-After and stops for auth, input and exhausted quota", () => {
  const httpFailure = (status, code, headers = {}) => failure(OpenAI.APIError.generate(
    status, { error: { code, message: "fixture" } }, undefined,
    new Headers({ "x-request-id": "provider-request", ...headers }),
  ));
  for (const status of [408, 409, 429, 500, 502, 503, 504]) {
    const event = httpFailure(status, "fixture");
    assert.equal(event.retryable, true, status);
    assert.equal(event.status, status);
    assert.equal(event.providerRequestId, "provider-request");
  }
  for (const status of [400, 401, 403, 404, 413, 422, 501, 505]) {
    assert.equal(httpFailure(status, "fixture").retryable, false, status);
    assert.equal(httpFailure(status, "ECONNRESET").retryable, false, "HTTP status takes precedence");
  }
  assert.equal(httpFailure(429, "insufficient_quota").retryable, false);
  assert.equal(httpFailure(503, "fixture", { "retry-after": "12.5" }).retryAfterMs, 12500);
  assert.equal(httpFailure(429, "fixture", { "retry-after-ms": "700" }).retryAfterMs, 700);
  assert.equal(httpFailure(429, "fixture", { "retry-after": "99999999" }).retryAfterMs, 300000);
  assert.equal(httpFailure(503, "fixture", { "retry-after": "nonsense" }).retryAfterMs, undefined);
  assert.equal(httpFailure(503, "fixture", { "retry-after": "-1" }).retryAfterMs, undefined);
  const dateDelay = httpFailure(503, "fixture", { "retry-after": new Date(Date.now() + 60000).toUTCString() }).retryAfterMs;
  assert.ok(dateDelay > 58000 && dateDelay <= 60000);
});

test("streamed terminal failures use the same transient policy while retaining their original codes", () => {
  for (const [code, retryable] of [["server_error", true], ["rate_limit_exceeded", true],
    ["invalid_prompt", false], ["context_length_exceeded", false], ["unknown_vendor_error", false]]) {
    const state = { requestId: "retry-probe", sequence: 0, started: true };
    const response = {
      id: "response", created_at: 0, error: { code, message: "fixture" },
    };
    const [event] = normalizeResponseStreamEvent({ type: "response.failed", response }, state);
    assert.equal(event.retryable, retryable);
    assert.equal(event.code, code);
  }
});

test('HTTP and SDK stream errors honor typed quota, status and auth facts, never retry prose', () => {
  for (const SDK of [OpenAI, Anthropic]) {
    for (const [status, body, retryable, expectedStatus] of [
      [429, { type: 'insufficient_quota' }, false, 429],
      [429, { type: 'rate_limit_error' }, true, 429],
      [503, { type: 'overloaded_error' }, true, 503],
      [401, { code: 'server_error', status: 503 }, false, 401],
      [undefined, { type: 'error', code: 503 }, true, 503],
      [undefined, { type: 'error', code: 501 }, false, 501],
      [undefined, { type: 'error', code: 505 }, false, 505],
      [undefined, { type: 'authentication_error' }, false, undefined],
      [undefined, { type: 'unknown_vendor_error', message: 'Please retry this temporary server error' }, false, undefined],
    ]) {
      const payload = { message: 'fixture', ...body };
      // SSE readers construct APIError directly; generate(undefined) means a
      // failed HTTP connection in both SDKs and would test the wrong boundary.
      const error = status === undefined
        ? new SDK.APIError(undefined, SDK === OpenAI ? payload : { error: payload }, undefined, new Headers(), payload.type)
        : SDK.APIError.generate(status, { error: payload }, undefined, new Headers());
      const event = failure(error);
      assert.equal(event.retryable, retryable, `${SDK.name}: ${status}: ${JSON.stringify(body)}`);
      assert.equal(event.status, expectedStatus);
      if (typeof body.type === 'string' && body.type !== 'error' && body.code === undefined) assert.equal(event.code, body.type);
    }
  }
});

test("real SDK fetch wrapper keeps the cause and leaves transport retries to Runtime", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new TypeError("fetch failed", { cause: cause("ECONNRESET") });
  });
  const provider = new OpenAIResponsesProvider({ apiKey: "fixture-only", baseURL: "https://fixture.invalid" });
  const events = [];
  const diagnostics = [];
  for await (const event of provider.stream(request, { onCompatibilityDiagnostic: event => diagnostics.push(event) })) events.push(event);
  assert.equal(requests, 1);
  assert.deepEqual(diagnostics, []);
  assert.equal(events.at(-1).code, "ECONNRESET");
  assert.equal(events.at(-1).retryable, true);
  assert.doesNotMatch(JSON.stringify(events), /SENSITIVE/);
});

test("an SSE socket failure after visible output remains retryable", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      const data = { type: "response.output_text.delta", delta: "partial" };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      setTimeout(() => controller.error(new TypeError("terminated", { cause: cause("UND_ERR_SOCKET") })), 25);
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const provider = new OpenAIResponsesProvider({ apiKey: "fixture-only", baseURL: "https://fixture.invalid" });
  const events = [];
  for await (const event of provider.stream(request)) events.push(event);
  assert.ok(events.some(event => event.kind === "text_delta" && event.delta === "partial"));
  assert.equal(events.at(-1).code, "UND_ERR_SOCKET");
  assert.equal(events.at(-1).retryable, true);
});
