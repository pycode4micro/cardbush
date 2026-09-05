import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_RUNTIME_GUIDANCE_PROTOCOL,
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND,
  RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
} from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost, LogicMemoryStore, ToolRegistry } from "../dist/index.js";

const NOW = "2026-08-29T00:00:00.000Z";

test("detaching a UI stream keeps its Turn running and resumes from the cursor exactly once", async () => {
  let releaseModel;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  let calls = 0;
  const host = new InMemoryRuntimeHost({provider:{async *stream(request) {
    calls += 1;
    yield event(request.requestId,0,"response_started");
    yield event(request.requestId,1,"text_delta",{delta:"before reload"});
    await modelGate;
    yield event(request.requestId,2,"text_delta",{delta:" after reload"});
    yield event(request.requestId,3,"response_completed",{finishReason:"stop"});
  }}});
  const request=sessionRequest("request_reload","turn_reload","user_reload","continue once");
  const oldController=new AbortController();
  const before=[];
  const oldStream=(async()=>{
    for await(const fact of host.openEventStream({sessionId:request.sessionId,turnId:request.turnId,signal:oldController.signal})) {
      before.push(fact);
    }
  })();
  let settled=false;
  const command=host.sendCommand({kind:RUN_RUNTIME_SESSION_TURN_COMMAND,payload:request}).then(value=>{settled=true;return value;});
  try {
    await waitFor(()=>before.some(fact=>fact.kind==='assistant_segment_delta'));
    oldController.abort();await oldStream;
    assert.equal(settled,false,'subscription cancellation must not end the model Turn');
    const last=before.at(-1);
    const after=[];
    const nextStream=(async()=>{
      for await(const fact of host.openEventStream({sessionId:request.sessionId,turnId:request.turnId,
        cursor:{afterSequence:last.sequence,lastEventId:last.eventId}})) after.push(fact);
    })();
    releaseModel();
    const result=await command;await nextStream;
    assert.equal(result.payload.status,'completed');
    assert.equal(calls,1,'reconnecting must not send another model request');
    assert.ok(after.every(fact=>fact.sequence>last.sequence));
    assert.equal(new Set([...before,...after].map(fact=>fact.eventId)).size,before.length+after.length);
    assert.equal(after.filter(fact=>fact.kind==='turn_terminal').length,1);
    const session=await host.sendCommand({kind:GET_RUNTIME_SESSION_COMMAND,payload:{sessionId:request.sessionId}});
    assert.equal(session.turns.length,1,'one canonical Turn is archived');
  } finally {releaseModel();oldController.abort();await command;}
});

test("runs consecutive Session Turns from durable facts without duplicating the prefix", async () => {
  const observedRequests = [];
  let response = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        response += 1;
        yield event(request.requestId, 0, "response_started");
        yield event(request.requestId, 1, "reasoning_delta", { delta: `private-${response}` });
        yield event(request.requestId, 2, "text_delta", { delta: `answer-${response}` });
        yield event(request.requestId, 3, "usage", {
          inputTokens: response * 10,
          outputTokens: response,
          cachedInputTokens: response * 5,
        });
        yield event(request.requestId, 4, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant"),
      createSegmentId: counter("segment"),
    },
  });

  const firstRequest = sessionRequest("request_1", "turn_1", "user_1", "first");
  firstRequest.inputMessages[0].metadata = {
    attachments: [{
      id: "attachment-1",
      name: "brief.md",
      type: "document",
      path: "C:\\workspace\\brief.md",
    }],
  };
  await host.sendCommand({
    kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
    payload: firstRequest,
  });
  await host.sendCommand({
    kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
    payload: sessionRequest("request_2", "turn_2", "user_2", "second"),
  });

  assert.deepEqual(observedRequests[0].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
  ]);
  assert.deepEqual(
    observedRequests[0].tools.map((tool) => tool.name),
    ["checkpoint_context"],
  );
  assert.deepEqual(observedRequests[1].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
    "answer-1",
    "second",
  ]);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].usage.inputTokens, 10);
  assert.equal(snapshot.turns[0].usage.lastRequestInputTokens, 10);
  assert.equal(snapshot.turns[1].usage.cachedInputTokens, 10);
  assert.equal(snapshot.turns[1].usage.lastRequestCachedInputTokens, 10);
  assert.equal(snapshot.turns[0].cacheChainState.requestOrdinal, 1);
  assert.equal(snapshot.turns[1].cacheChainState.requestOrdinal, 2);
  assert.equal(snapshot.turns.flatMap((turn) => turn.messages).length, 4);
  assert.equal(
    snapshot.turns[0].messages.find((message) => message.message.role === "assistant")
      .message.reasoningContent,
    "private-1",
  );
  assert.deepEqual(snapshot.turns[0].messages[0].metadata.attachments, [{
    id: "attachment-1",
    name: "brief.md",
    type: "document",
    path: "C:\\workspace\\brief.md",
  }]);
  const conversationSnapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1", messageProjection: "conversation" },
  });
  assert.equal(
    conversationSnapshot.turns
      .flatMap((turn) => turn.messages)
      .some((message) => message.message.role === "tool"),
    false,
  );
  assert.equal(
    conversationSnapshot.turns[0].messages
      .find((message) => message.message.role === "assistant")
      .message.reasoningContent,
    undefined,
  );
  assert.equal(
    snapshot.turns[0].messages
      .find((message) => message.message.role === "assistant")
      .message.reasoningContent,
    "private-1",
    "conversation reads must not mutate the canonical append-only snapshot",
  );
  assert.ok(host.capabilities().features.includes("append_only_session_context"));
  assert.ok(host.capabilities().features.includes("cross_turn_cache_chain"));
  assert.ok(host.capabilities().features.includes("stopped_turn_continuation"));
});

test("stops an uncooperative provider, commits partial facts, and continues the Cache Chain", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 1) {
          yield event(request.requestId, 1, "text_delta", { delta: "partial-before-stop" });
          await new Promise(() => {});
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "continued-after-stop" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_stopped"),
      createSegmentId: counter("segment_stopped"),
    },
  });

  const first = host.runSessionTurn(
    sessionRequest("request_stop_1", "turn_stop_1", "user_stop_1", "first"),
  );
  await waitFor(() => host.events("session_1", "turn_stop_1")
    .some((candidate) => candidate.kind === "assistant_segment_delta"));
  const receipt = await host.sendCommand({
    kind: "runtime.stop_turn",
    payload: { sessionId: "session_1", turnId: "turn_stop_1" },
  });
  const stopped = await Promise.race([
    first,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Stop remained blocked by an uncooperative Provider.")),
      1_000,
    )),
  ]);

  assert.equal(receipt.accepted, true);
  assert.equal(stopped.payload.status, "stopped");
  const afterStop = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.deepEqual(afterStop.turns[0].messages.map((item) => item.message.content), [
    "first",
    "partial-before-stop",
  ]);
  assert.equal(afterStop.turns[0].cacheChainState.requestOrdinal, 1);

  await host.runSessionTurn(
    sessionRequest("request_stop_2", "turn_stop_2", "user_stop_2", "continue"),
  );
  assert.deepEqual(observedRequests[1].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
    "partial-before-stop",
    "continue",
  ]);
  const observation = host.events("session_1", "turn_stop_2")
    .find((candidate) => candidate.kind === "cache_chain_observed");
  assert.equal(observation.payload.previousMessageCount, 2);
  assert.equal(observation.payload.sharedPrefixMessages, 2);
  assert.equal(observation.payload.frozenPrefixBreak, false);
});

test("edit and regenerate inherit the prior Cache Chain and expose the real break", async () => {
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        yield event(request.requestId, 0, "response_started");
        yield event(request.requestId, 1, "text_delta", { delta: `answer:${request.turnId}` });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  await host.runSessionTurn(
    sessionRequest("request_edit_1", "turn_edit_1", "user_edit_1", "original"),
  );
  const before = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  await host.sendCommand({
    kind: SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
    payload: {
      sessionId: "session_1",
      messageIds: before.turns[0].messages.map((message) => message.messageId),
      reason: "user_edit_regenerate",
    },
  });
  await host.runSessionTurn(
    sessionRequest("request_edit_2", "turn_edit_2", "user_edit_2", "replacement"),
  );

  const observation = host.events("session_1", "turn_edit_2")
    .find((candidate) => candidate.kind === "cache_chain_observed");
  assert.equal(observation.payload.requestOrdinal, 2);
  assert.equal(observation.payload.previousMessageCount, 2);
  assert.equal(observation.payload.sharedPrefixMessages, 1);
  assert.equal(observation.payload.frozenPrefixBreak, true);
  assert.equal(observation.payload.breakIndex, 1);
});

test("exposes exact Session context through the typed command boundary", async () => {
  const host = new InMemoryRuntimeHost({
    provider: { async *stream() {} },
    eventLogOptions: deterministicEventLogOptions(),
  });

  assert.equal(
    await host.sendCommand({
      kind: GET_RUNTIME_SESSION_COMMAND,
      payload: { sessionId: "missing" },
    }),
    null,
  );
  const context = await host.sendCommand({
    kind: ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
    payload: {
      sessionId: "session_1",
      prefixMessages: [{ role: "system", content: "prefix" }],
      currentMessages: [{ role: "user", content: "current" }],
    },
  });
  assert.deepEqual(context.messages.map((message) => message.content), ["prefix", "current"]);
  assert.deepEqual(context.sourceMessageIds, []);
});

test("serializes Session Turn commits while allowing the next Turn after completion", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        calls += 1;
        yield event(request.requestId, 0, "response_started");
        if (calls === 1) await firstGate;
        yield event(request.requestId, 1, "text_delta", { delta: `answer-${calls}` });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });

  const first = host.runSessionTurn(
    sessionRequest("request_serial_1", "turn_serial_1", "user_serial_1", "first"),
  );
  await assert.rejects(
    host.runSessionTurn(
      sessionRequest("request_serial_2", "turn_serial_2", "user_serial_2", "second"),
    ),
    /already has active Turn/,
  );
  releaseFirst();
  await first;
  await host.runSessionTurn(
    sessionRequest("request_serial_2", "turn_serial_2", "user_serial_2", "second"),
  );

  assert.equal((await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  })).turns.length, 2);
});

test("associates assistant thumbs with LEM records used by that Turn", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cardbush-runtime-lem-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const memory = new LogicMemoryStore(join(dataRoot, "lem", "logic.json"));
  const learned = await memory.learn({
    scenario: "before final verification",
    bias: "claiming completion without tests",
    correction: "run proportionate verification before final",
    evidence_state: "verified",
  });
  let round = 0;
  const host = new InMemoryRuntimeHost({
    dataRoot,
    provider: {
      async *stream(request) {
        round += 1;
        yield event(request.requestId, 0, "response_started");
        if (round === 1) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_consult_logic",
            nameDelta: "consult_logic",
            argumentsDelta: JSON.stringify({ query: "final verification before completion" }),
          });
          yield event(request.requestId, 2, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "verified answer" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_lem"),
      createSegmentId: counter("segment_lem"),
    },
  });
  const lemRequest = sessionRequest("request_lem", "turn_lem", "user_lem", "finish safely");
  const catalog = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  lemRequest.tools = catalog.filter((definition) => definition.name === "consult_logic");
  await host.runSessionTurn(lemRequest);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.ok(snapshot.turns[0].messages.some((message) =>
    message.message.role === "tool"));
  const conversationSnapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1", messageProjection: "conversation" },
  });
  assert.equal(conversationSnapshot.turns[0].messages.some((message) =>
    message.message.role === "tool"), false);
  const finalMessage = snapshot.turns[0].messages.find((message) =>
    message.message.role === "assistant" && message.message.content === "verified answer");
  assert.ok(finalMessage);
  const feedback = await host.sendCommand({
    kind: RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
    payload: {
      sessionId: "session_1",
      turnId: "turn_lem",
      messageId: finalMessage.messageId,
      rating: "up",
    },
  });
  assert.deepEqual(feedback.associatedLogicIds, [learned.logic_id]);
  assert.deepEqual(feedback.updatedLogicIds, [learned.logic_id]);
  const stored = JSON.parse(await readFile(memory.path, "utf8"))[0];
  assert.equal(stored.positive_feedback_count, 1);
});

test("forces atomic context compaction and resumes the same active Turn", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens(request) {
        return {
          inputTokens: request.messages.some((message) =>
            message.name === "turn_context_summary")
              ? 100
            : request.messages.some((message) => message.name === "context_pressure")
              ? 2_900
              : 2_860,
          source: "provider",
        };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 1) {
          yield event(request.requestId, 1, "text_delta", { delta: "first complete" });
          yield event(request.requestId, 2, "usage", {
            inputTokens: 60,
            outputTokens: 4,
            cachedInputTokens: 20,
          });
          yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
          return;
        }
        if (
          request.tools.some((tool) => tool.name === "checkpoint_context") &&
          request.messages.some((message) => message.name === "context_pressure")
        ) {
          const argumentsText = JSON.stringify({
            session_revision: 2,
            summaries: [{
              turn_id: "turn_compact_1",
              summary: "The user supplied a large prior payload; the Turn completed without external side effects.",
            }],
          });
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: argumentsText,
          });
          yield event(request.requestId, 2, "usage", {
            inputTokens: 90,
            outputTokens: 8,
            cachedInputTokens: 50,
          });
          yield event(request.requestId, 3, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "second complete" });
        yield event(request.requestId, 2, "usage", {
          inputTokens: 110,
          outputTokens: 5,
          cachedInputTokens: 80,
        });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_compact"),
      createSegmentId: counter("segment_compact"),
    },
  });

  await host.runSessionTurn(sessionRequest(
    "request_compact_1",
    "turn_compact_1",
    "user_compact_1",
    "x".repeat(20),
  ));
  const second = sessionRequest(
    "request_compact_2",
    "turn_compact_2",
    "user_compact_2",
    "continue",
  );
  second.tools = [ordinaryToolDefinition()];
  second.maxOutputTokens = 1000;
  second.metadata = { contextWindowTokens: 4000 };
  await host.runSessionTurn(second);

  assert.equal(observedRequests.length, 3);
  assert.deepEqual(
    observedRequests[1].tools.map((tool) => tool.name),
    ["ordinary_tool", "checkpoint_context"],
  );
  assert.deepEqual(
    observedRequests[2].tools.map((tool) => tool.name),
    ["ordinary_tool", "checkpoint_context"],
  );
  assert.match(
    observedRequests[2].messages.find((message) => message.name === "turn_context_summary")?.content ?? "",
    /large prior payload/,
  );
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.match(snapshot.turns[0].contextSummary, /large prior payload/);
  assert.equal(snapshot.turns[0].messages[0].message.content.length, 20);
  assert.equal(snapshot.turns[1].messages.length, 2);
  assert.equal(snapshot.turns[1].usage.inputTokens, 200);
  assert.equal(snapshot.turns[1].usage.model, "model");
  assert.equal(snapshot.turns[1].usage.contextWindowTokens, 4000);
  assert.equal(snapshot.turns[1].usage.lastRequestInputTokens, 110);
  assert.equal(snapshot.turns[1].usage.lastRequestCachedInputTokens, 80);
  assert.deepEqual(
    host.events("session_1", "turn_compact_2")
      .filter((event) => event.kind === "model_request_usage")
      .map((event) => event.payload),
    [
      {
        round: 1,
        attempt: 1,
        model: "model",
        contextWindowTokens: 4000,
        inputTokens: 90,
        outputTokens: 8,
        cachedInputTokens: 50,
        preflightInputTokens: 2900,
        preflightMeasurement: "provider",
        usableInputTokens: 3000,
      },
      {
        round: 2,
        attempt: 1,
        model: "model",
        contextWindowTokens: 4000,
        inputTokens: 110,
        outputTokens: 5,
        cachedInputTokens: 80,
        preflightInputTokens: 100,
        preflightMeasurement: "provider",
        usableInputTokens: 3000,
      },
    ],
    "each Provider request in one Turn must publish its own live context usage",
  );
  assert.equal(
    snapshot.turns[1].messages.some((message) =>
      message.message.role === "assistant" &&
      message.message.toolCalls.some((toolCall) => toolCall.name === "checkpoint_context")),
    false,
  );
  assert.equal(
    host.events("session_1", "turn_compact_2")
      .filter((event) => event.kind === "assistant_segment_started").length,
    1,
  );
  const compactionEvents = host.events("session_1", "turn_compact_2")
    .filter((event) => event.kind.startsWith("context_compaction_"));
  assert.deepEqual(
    compactionEvents.map((event) => event.kind),
    ["context_compaction_started", "context_compaction_completed"],
  );
  assert.equal(compactionEvents[0].payload.precedingTurnCount, 1);
  assert.equal(compactionEvents[0].payload.activeTurnIncluded, false);
  assert.equal(compactionEvents[1].payload.summarizedTurnCount, 1);
  assert.equal("summary" in compactionEvents[1].payload, false);
  assert.deepEqual(
    await host.sendCommand({
      kind: LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND,
      payload: { sessionId: "session_1", turnId: "turn_compact_2" },
    }),
    compactionEvents,
    "history reads must recover the same explicit lifecycle facts",
  );
});

test("checkpoints an oversized active Turn at a safe Tool boundary and continues in place", async () => {
  const observedRequests = [];
  const registry = new ToolRegistry().register({
    definition: ordinaryToolDefinition(),
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_scope: "turn",
      mutating: false,
    },
    decodeInput: (input) => input,
    execute: (context) => ({ observed_call: context.toolCallId }),
  });
  let normalRound = 0;
  const host = new InMemoryRuntimeHost({
    toolRegistry: registry,
    provider: {
      async countInputTokens(request) {
        if (request.messages.some((message) =>
          message.name === "context_checkpoint_resume")) {
          return { inputTokens: 180, source: "provider" };
        }
        if (request.messages.some((message) => message.name === "context_pressure")) {
          return { inputTokens: 2_900, source: "provider" };
        }
        if (request.messages.some((message) => message.role === "tool")) {
          return { inputTokens: 2_860, source: "provider" };
        }
        return { inputTokens: 100, source: "provider" };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        yield event(request.requestId, 0, "response_started");
        const pressure = request.messages.find((message) =>
          message.name === "context_pressure");
        if (pressure) {
          const activeTurnId = pressure.content.match(/- turn_id: (.+)/)?.[1];
          const throughMessageId = pressure.content.match(
            /- through_message_id: (.+)/,
          )?.[1];
          assert.ok(activeTurnId);
          assert.ok(throughMessageId);
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_active_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 1,
              summaries: [],
              active_turn: {
                turn_id: activeTurnId,
                through_message_id: throughMessageId,
                summary: "The user requested an active-loop continuation. The first observation completed successfully with no external side effect; next execute the second observation and then report completion.",
              },
            }),
          });
          yield event(request.requestId, 2, "usage", { inputTokens: 2_900 });
          yield event(request.requestId, 3, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        normalRound += 1;
        if (normalRound <= 2) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: normalRound === 1 ? "call_before_checkpoint" : "call_after_checkpoint",
            nameDelta: "ordinary_tool",
            argumentsDelta: "{}",
          });
          yield event(request.requestId, 2, "usage", { inputTokens: normalRound * 100 });
          yield event(request.requestId, 3, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        yield event(request.requestId, 1, "text_delta", {
          delta: "active Turn continued and completed",
        });
        yield event(request.requestId, 2, "usage", { inputTokens: 220 });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_active"),
      createSegmentId: counter("segment_active"),
    },
  });
  const request = sessionRequest(
    "request_active_checkpoint",
    "turn_active_checkpoint",
    "user_active_checkpoint",
    "perform both observations and finish",
  );
  request.tools = [ordinaryToolDefinition()];
  request.maxOutputTokens = 1_000;
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 4);
  const continued = observedRequests[2];
  assert.deepEqual(
    continued.messages.map((message) => [message.role, message.name]),
    [
      ["system", undefined],
      ["user", undefined],
      ["assistant", undefined],
      ["developer", "context_checkpoint_resume"],
    ],
  );
  assert.match(continued.messages[2].content, /active_turn_checkpoint/);
  assert.match(continued.messages[2].content, /first observation completed/);
  assert.equal(
    continued.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "call_before_checkpoint"),
    false,
  );
  assert.ok(observedRequests.every((item) =>
    item.tools.map((tool) => tool.name).join(",") ===
      "ordinary_tool,checkpoint_context"));

  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns.length, 1);
  assert.match(snapshot.turns[0].contextCheckpoint.summary, /first observation completed/);
  assert.equal(
    snapshot.turns[0].messages.some((message) =>
      message.message.role === "tool" &&
      message.message.toolCallId === "call_before_checkpoint"),
    true,
    "the canonical Session must retain the compacted Tool history",
  );
  assert.equal(
    snapshot.turns[0].messages.some((message) =>
      message.message.role === "assistant" &&
      message.message.toolCalls.some((call) => call.name === "checkpoint_context")),
    false,
    "maintenance output must not become conversation history",
  );
  const projected = await host.sendCommand({
    kind: ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(
    projected.messages.some((message) => message.name === "context_checkpoint_resume"),
    false,
    "a completed historical Turn must not receive an active-loop resume instruction",
  );
  assert.equal(
    projected.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "call_before_checkpoint"),
    false,
  );
  assert.equal(
    projected.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "call_after_checkpoint"),
    true,
  );
  const activeCompactionEvents = host.events(
    "session_1",
    "turn_active_checkpoint",
  ).filter((event) => event.kind.startsWith("context_compaction_"));
  assert.deepEqual(
    activeCompactionEvents.map((event) => event.kind),
    ["context_compaction_started", "context_compaction_completed"],
  );
  assert.equal(activeCompactionEvents[0].payload.activeTurnIncluded, true);
  assert.equal(
    activeCompactionEvents[0].payload.assistantMessageId,
    "assistant_active_1",
  );
  assert.equal(
    activeCompactionEvents[0].payload.assistantContentOffset,
    0,
  );
  assert.equal(activeCompactionEvents[1].payload.activeTurnCheckpointed, true);
});

test("bounds a parallel Tool batch before it can consume the checkpoint reserve", async () => {
  const observedRequests = [];
  const countedInputs = [];
  const registry = new ToolRegistry().register({
    definition: ordinaryToolDefinition(),
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read_large",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_scope: "turn",
      mutating: false,
    },
    parallelSafe: true,
    decodeInput: (input) => input,
    execute: (context) => ({
      observed_call: context.toolCall.id,
      payload: "x".repeat(48_000),
    }),
  });
  let normalRound = 0;
  const host = new InMemoryRuntimeHost({
    toolRegistry: registry,
    provider: {
      async countInputTokens(request) {
        const toolResultChars = request.messages
          .filter((message) => message.role === "tool")
          .reduce((total, message) => total + message.content.length, 0);
        const hasPressure = request.messages.some((message) =>
          message.name === "context_pressure");
        const hasResume = request.messages.some((message) =>
          message.name === "context_checkpoint_resume");
        const inputTokens = hasResume
          ? 1_000
          : toolResultChars > 0
            ? 230_928 + toolResultChars + (hasPressure ? 500 : 0)
            : 229_244;
        countedInputs.push(inputTokens);
        return { inputTokens, source: "provider" };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        yield event(request.requestId, 0, "response_started");
        const pressure = request.messages.find((message) =>
          message.name === "context_pressure");
        if (pressure) {
          const activeTurnId = pressure.content.match(/- turn_id: (.+)/)?.[1];
          const throughMessageId = pressure.content.match(
            /- through_message_id: (.+)/,
          )?.[1];
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_parallel_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 1,
              summaries: [],
              active_turn: {
                turn_id: activeTurnId,
                through_message_id: throughMessageId,
                summary: "Five large observations were persisted and projected through durable archive locators; continue without repeating them.",
              },
            }),
          });
          yield event(request.requestId, 2, "usage", {
            inputTokens: countedInputs.at(-1),
            outputTokens: 200,
          });
          yield event(request.requestId, 3, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        normalRound += 1;
        if (normalRound === 1) {
          for (let index = 0; index < 5; index += 1) {
            yield event(request.requestId, index + 1, "tool_call_delta", {
              index,
              toolCallId: `call_parallel_large_${index}`,
              nameDelta: "ordinary_tool",
              argumentsDelta: "{}",
            });
          }
          yield event(request.requestId, 6, "usage", {
            inputTokens: 229_244,
            outputTokens: 1_684,
          });
          yield event(request.requestId, 7, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        yield event(request.requestId, 1, "text_delta", {
          delta: "completed after bounded ingress and checkpoint",
        });
        yield event(request.requestId, 2, "usage", {
          inputTokens: 1_000,
          outputTokens: 20,
        });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_parallel_budget",
    "turn_parallel_budget",
    "user_parallel_budget",
    "inspect five large sources and finish",
  );
  request.tools = [ordinaryToolDefinition()];
  request.metadata = { contextWindowTokens: 256_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 3);
  assert.equal(
    observedRequests[0].maxOutputTokens,
    8_192,
    "the Runtime reserve must also be enforced on the Provider request",
  );
  const maintenanceRequest = observedRequests[1];
  const projectedToolResults = maintenanceRequest.messages.filter((message) =>
    message.role === "tool");
  assert.equal(projectedToolResults.length, 5);
  assert.equal(
    projectedToolResults.reduce((total, message) => total + message.content.length, 0) <= 14_512,
    true,
    "all parallel Tool results must share the remaining context-ingress budget",
  );
  assert.ok(projectedToolResults.every((message) => {
    const result = JSON.parse(message.content);
    return result.archived === true &&
      result.locator.includes(encodeURIComponent(message.toolCallId));
  }));
  assert.equal(
    projectedToolResults.some((message) =>
      JSON.parse(message.content).contextCheckpointProjection === true),
    false,
    "new Tool rounds must fit without using the legacy emergency projection",
  );
  assert.equal(countedInputs[2] < 247_808, true);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.match(snapshot.turns[0].contextCheckpoint.summary, /Five large observations/);
  assert.equal(
    snapshot.turns[0].messages.filter((message) => message.message.role === "tool").length,
    5,
  );
  const fullRecord = await host.sendCommand({
    kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND,
    payload: {
      sessionId: "session_1",
      turnId: "turn_parallel_budget",
      toolCallId: "call_parallel_large_0",
    },
  });
  assert.equal(fullRecord.result.payload.length, 48_000);
});

test("replaces an active-Turn checkpoint cumulatively when the same Loop fills again", async () => {
  const observedRequests = [];
  const registry = new ToolRegistry().register({
    definition: ordinaryToolDefinition(),
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_scope: "turn",
      mutating: false,
    },
    decodeInput: (input) => input,
    execute: (context) => ({ observed_call: context.toolCallId }),
  });
  let normalRound = 0;
  let checkpointRound = 0;
  const host = new InMemoryRuntimeHost({
    toolRegistry: registry,
    provider: {
      async countInputTokens(request) {
        if (request.messages.some((message) => message.name === "context_pressure")) {
          return { inputTokens: 2_900, source: "provider" };
        }
        if (request.messages.some((message) => message.role === "tool")) {
          return { inputTokens: 2_860, source: "provider" };
        }
        return { inputTokens: 100, source: "provider" };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        yield event(request.requestId, 0, "response_started");
        const pressure = request.messages.find((message) =>
          message.name === "context_pressure");
        if (pressure) {
          checkpointRound += 1;
          const activeTurnId = pressure.content.match(/- turn_id: (.+)/)?.[1];
          const throughMessageId = pressure.content.match(
            /- through_message_id: (.+)/,
          )?.[1];
          assert.ok(activeTurnId);
          assert.ok(throughMessageId);
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: `call_repeated_checkpoint_${checkpointRound}`,
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 1,
              summaries: [],
              active_turn: {
                turn_id: activeTurnId,
                through_message_id: throughMessageId,
                summary: checkpointRound === 1
                  ? "Checkpoint one: the first observation completed; next run the second observation."
                  : "Checkpoint two is cumulative: both the first and second observations completed; next return the final answer.",
              },
            }),
          });
          yield event(request.requestId, 2, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        normalRound += 1;
        if (normalRound <= 2) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: `call_repeated_tool_${normalRound}`,
            nameDelta: "ordinary_tool",
            argumentsDelta: "{}",
          });
          yield event(request.requestId, 2, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "done after two checkpoints" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_repeated"),
      createSegmentId: counter("segment_repeated"),
    },
  });
  const request = sessionRequest(
    "request_repeated_checkpoint",
    "turn_repeated_checkpoint",
    "user_repeated_checkpoint",
    "perform two observations and finish",
  );
  request.tools = [ordinaryToolDefinition()];
  request.maxOutputTokens = 1_000;
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 5);
  const finalRequest = observedRequests.at(-1);
  const checkpoints = finalRequest.messages.filter((message) =>
    message.role === "assistant" && message.content.includes("<active_turn_checkpoint"));
  assert.equal(checkpoints.length, 1);
  assert.match(checkpoints[0].content, /Checkpoint two is cumulative/);
  assert.doesNotMatch(checkpoints[0].content, /Checkpoint one:/);
  assert.equal(finalRequest.messages.filter((message) =>
    message.name === "context_checkpoint_resume").length, 1);
  assert.equal(finalRequest.messages.some((message) => message.role === "tool"), false);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.match(snapshot.turns[0].contextCheckpoint.summary, /both the first and second/);
  assert.equal(snapshot.turns[0].messages.filter((message) =>
    message.message.role === "tool").length, 2);
});

test("applies user guidance queued during context maintenance before the resumed model round", async () => {
  let releaseMaintenance;
  const maintenanceGate = new Promise((resolve) => {
    releaseMaintenance = resolve;
  });
  let markMaintenanceStarted;
  const maintenanceStarted = new Promise((resolve) => {
    markMaintenanceStarted = resolve;
  });
  const observedRequests = [];
  const registry = new ToolRegistry().register({
    definition: ordinaryToolDefinition(),
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_scope: "turn",
      mutating: false,
    },
    decodeInput: (input) => input,
    execute: () => ({ observed: true }),
  });
  let normalRound = 0;
  const host = new InMemoryRuntimeHost({
    toolRegistry: registry,
    provider: {
      async countInputTokens(request) {
        if (request.messages.some((message) => message.name === "context_pressure")) {
          return { inputTokens: 2_900, source: "provider" };
        }
        if (request.messages.some((message) => message.role === "tool")) {
          return { inputTokens: 2_860, source: "provider" };
        }
        return { inputTokens: 100, source: "provider" };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        yield event(request.requestId, 0, "response_started");
        const pressure = request.messages.find((message) =>
          message.name === "context_pressure");
        if (pressure) {
          markMaintenanceStarted();
          await maintenanceGate;
          const activeTurnId = pressure.content.match(/- turn_id: (.+)/)?.[1];
          const throughMessageId = pressure.content.match(
            /- through_message_id: (.+)/,
          )?.[1];
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_guidance_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 1,
              summaries: [],
              active_turn: {
                turn_id: activeTurnId,
                through_message_id: throughMessageId,
                summary: "The first observation completed; continue using any newly queued user guidance.",
              },
            }),
          });
          yield event(request.requestId, 2, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        normalRound += 1;
        if (normalRound === 1) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_before_guidance_checkpoint",
            nameDelta: "ordinary_tool",
            argumentsDelta: "{}",
          });
          yield event(request.requestId, 2, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "guidance applied" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_checkpoint_guidance",
    "turn_checkpoint_guidance",
    "user_checkpoint_guidance",
    "inspect and continue",
  );
  request.tools = [ordinaryToolDefinition()];
  request.maxOutputTokens = 1_000;
  request.metadata = { contextWindowTokens: 4_000 };
  const running = host.runSessionTurn(request);
  await maintenanceStarted;
  const receipt = await host.sendCommand({
    kind: ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
    payload: {
      protocol: BUSH_RUNTIME_GUIDANCE_PROTOCOL,
      sessionId: "session_1",
      turnId: "turn_checkpoint_guidance",
      messageId: "guidance_during_checkpoint",
      content: "Use the corrected scope before finishing.",
      createdAt: NOW,
    },
  });
  assert.equal(receipt.queueDepth, 1);
  releaseMaintenance();

  const terminal = await running;

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests[2].messages.at(-1).name, "turn_guidance");
  assert.match(observedRequests[2].messages.at(-1).content, /corrected scope/);
  const applied = host.events("session_1", "turn_checkpoint_guidance").find((item) =>
    item.kind === "guidance_applied");
  assert.equal(applied.payload.messageId, "guidance_during_checkpoint");
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns[0].messages.some((message) =>
    message.message.name === "turn_guidance"), true);
});

test("rejects a stale active-Turn boundary and accepts only the exact authorized retry", async () => {
  const observedRequests = [];
  const registry = new ToolRegistry().register({
    definition: ordinaryToolDefinition(),
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_scope: "turn",
      mutating: false,
    },
    decodeInput: (input) => input,
    execute: () => ({ observed: true }),
  });
  let normalRound = 0;
  let checkpointAttempt = 0;
  const host = new InMemoryRuntimeHost({
    toolRegistry: registry,
    provider: {
      async countInputTokens(request) {
        if (request.messages.some((message) => message.name === "context_pressure")) {
          return { inputTokens: 2_900, source: "provider" };
        }
        if (request.messages.some((message) => message.role === "tool")) {
          return { inputTokens: 2_860, source: "provider" };
        }
        return { inputTokens: 100, source: "provider" };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        yield event(request.requestId, 0, "response_started");
        const pressure = request.messages.filter((message) =>
          message.name === "context_pressure").at(-1);
        if (pressure) {
          checkpointAttempt += 1;
          const activeTurnId = pressure.content.match(/- turn_id: (.+)/)?.[1];
          const exactBoundary = pressure.content.match(
            /- through_message_id: (.+)/,
          )?.[1];
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: `call_boundary_checkpoint_${checkpointAttempt}`,
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 1,
              summaries: [],
              active_turn: {
                turn_id: activeTurnId,
                through_message_id: checkpointAttempt === 1
                  ? "forged_stale_boundary"
                  : exactBoundary,
                summary: checkpointAttempt === 1
                  ? "This forged summary must never be persisted."
                  : "The exact completed observation is preserved; return the final answer.",
              },
            }),
          });
          yield event(request.requestId, 2, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        normalRound += 1;
        if (normalRound === 1) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_before_boundary_checkpoint",
            nameDelta: "ordinary_tool",
            argumentsDelta: "{}",
          });
          yield event(request.requestId, 2, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "boundary verified" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_boundary_checkpoint",
    "turn_boundary_checkpoint",
    "user_boundary_checkpoint",
    "inspect and finish",
  );
  request.tools = [ordinaryToolDefinition()];
  request.maxOutputTokens = 1_000;
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 4);
  assert.equal(observedRequests[2].messages.some((message) =>
    message.name === "context_compaction_correction"), true);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.match(snapshot.turns[0].contextCheckpoint.summary, /exact completed observation/);
  assert.doesNotMatch(snapshot.turns[0].contextCheckpoint.summary, /forged/);
  const lifecycle = host.events("session_1", "turn_boundary_checkpoint")
    .filter((event) => event.kind.startsWith("context_compaction_"));
  assert.deepEqual(
    lifecycle.map((event) => event.kind),
    [
      "context_compaction_started",
      "context_compaction_retrying",
      "context_compaction_completed",
    ],
  );
  assert.equal(new Set(lifecycle.map((event) => event.payload.compactionId)).size, 1);
  assert.equal(lifecycle[1].payload.attempt, 2);
  assert.equal(lifecycle[2].payload.attempt, 2);
});

test("calibrates unsupported Provider token counts before an append-only Loop can exceed its window", async () => {
  const observedRequests = [];
  let call = 0;
  const registry = new ToolRegistry().register({
    definition: ordinaryToolDefinition(),
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_scope: "turn",
      mutating: false,
    },
    decodeInput: (input) => input,
    execute: () => ({ value: "observed" }),
  });
  const host = new InMemoryRuntimeHost({
    toolRegistry: registry,
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 1) {
          yield event(request.requestId, 1, "text_delta", { delta: "large context ready" });
          yield event(request.requestId, 2, "usage", { inputTokens: 85_000 });
          yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
          return;
        }
        if (call === 2) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_observe",
            nameDelta: "ordinary_tool",
            argumentsDelta: "{}",
          });
          yield event(request.requestId, 2, "usage", { inputTokens: 88_000 });
          yield event(request.requestId, 3, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        if (request.messages.some((message) => message.name === "context_pressure")) {
          const pressure = request.messages.find((message) =>
            message.name === "context_pressure").content;
          const activeTurnId = pressure.match(/- turn_id: (.+)/)?.[1];
          const throughMessageId = pressure.match(/- through_message_id: (.+)/)?.[1];
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_calibrated_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 2,
              summaries: [{
                turn_id: "turn_calibration_1",
                summary: "A large preceding Turn established the working context without external side effects.",
              }],
              ...(activeTurnId && throughMessageId
                ? {
                    active_turn: {
                      turn_id: activeTurnId,
                      through_message_id: throughMessageId,
                      summary: "The active Turn inspected the ordinary fixture and must now finish the requested work without repeating that observation.",
                    },
                  }
                : {}),
            }),
          });
          yield event(request.requestId, 2, "usage", { inputTokens: 89_000 });
          yield event(request.requestId, 3, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", {
          delta: "completed after calibrated compaction",
        });
        yield event(request.requestId, 2, "usage", { inputTokens: 5_000 });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });

  await host.runSessionTurn(sessionRequest(
    "request_calibration_1",
    "turn_calibration_1",
    "user_calibration_1",
    "x".repeat(190_000),
  ));
  const second = sessionRequest(
    "request_calibration_2",
    "turn_calibration_2",
    "user_calibration_2",
    "continue",
  );
  second.tools = [ordinaryToolDefinition()];
  second.maxOutputTokens = 8_000;
  second.metadata = { contextWindowTokens: 100_000 };
  await host.runSessionTurn(second);

  assert.equal(observedRequests.length, 4);
  assert.equal(
    observedRequests[2].messages.some((message) => message.name === "context_pressure"),
    true,
    "the real 88k request must force compaction before another normal API request",
  );
  assert.equal(
    observedRequests.slice(0, 3).some((request) =>
      request.messages.some((message) => message.name === "turn_context_summary")),
    false,
  );
  assert.equal(
    observedRequests[3].messages.some((message) => message.name === "turn_context_summary"),
    true,
  );
  const usageEvents = host.events("session_1", "turn_calibration_2")
    .filter((candidate) => candidate.kind === "model_request_usage");
  assert.equal(usageEvents[0].payload.preflightMeasurement, "fallback_estimate");
  assert.equal(usageEvents[1].payload.preflightInputTokens >= 88_000, true);
  assert.equal(usageEvents.at(-1).payload.inputTokens, 5_000);
});

test("permits one bounded maintenance request to recover an already over-limit Session", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 1) {
          yield event(request.requestId, 1, "text_delta", { delta: "oversized history ready" });
          yield event(request.requestId, 2, "usage", { inputTokens: 105_000 });
          yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
          return;
        }
        if (request.messages.some((message) => message.name === "context_pressure")) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_over_limit_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 2,
              summaries: [{
                turn_id: "turn_over_limit_1",
                summary: "The preceding oversized Turn completed without external side effects.",
              }],
            }),
          });
          yield event(request.requestId, 2, "usage", { inputTokens: 106_000 });
          yield event(request.requestId, 3, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "recovered" });
        yield event(request.requestId, 2, "usage", { inputTokens: 5_000 });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });

  const oversized = sessionRequest(
    "request_over_limit_1",
    "turn_over_limit_1",
    "user_over_limit_1",
    "x".repeat(190_000),
  );
  oversized.maxOutputTokens = 8_000;
  oversized.metadata = { contextWindowTokens: 100_000 };
  await host.runSessionTurn(oversized);
  const recovery = sessionRequest(
    "request_over_limit_2",
    "turn_over_limit_2",
    "user_over_limit_2",
    "recover",
  );
  recovery.maxOutputTokens = 8_000;
  recovery.metadata = { contextWindowTokens: 100_000 };
  const terminal = await host.runSessionTurn(recovery);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 3);
  assert.equal(
    observedRequests[1].messages.some((message) => message.name === "context_pressure"),
    true,
  );
  assert.equal(
    observedRequests[2].messages.some((message) => message.name === "turn_context_summary"),
    true,
  );
  assert.equal(
    observedRequests.some((request, index) =>
      index > 0 &&
      !request.messages.some((message) =>
        message.name === "context_pressure" || message.name === "turn_context_summary")),
    false,
    "an already over-limit Session must not dispatch another ordinary model request before recovery",
  );
});

test("keeps checkpoint_context visible but rejects proactive compaction below 95 percent", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 2) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_proactive_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 2,
              summaries: [{ turn_id: "turn_proactive_1", summary: "Should be rejected." }],
            }),
          });
          yield event(request.requestId, 2, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", {
          delta: call === 1 ? "first complete" : "continued without compaction",
        });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_proactive"),
      createSegmentId: counter("segment_proactive"),
    },
  });

  await host.runSessionTurn(sessionRequest(
    "request_proactive_1",
    "turn_proactive_1",
    "user_proactive_1",
    "x".repeat(9_000),
  ));
  const second = sessionRequest(
    "request_proactive_2",
    "turn_proactive_2",
    "user_proactive_2",
    "continue",
  );
  second.maxOutputTokens = 256;
  second.metadata = { contextWindowTokens: 4000 };
  const terminal = await host.runSessionTurn(second);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 3);
  assert.ok(observedRequests.every((request) =>
    request.tools.some((tool) => tool.name === "checkpoint_context")));
  assert.equal(
    observedRequests[1].messages.some((message) => message.name === "context_pressure"),
    false,
  );
  assert.match(
    observedRequests[2].messages.find((message) =>
      message.name === "context_compaction_correction")?.content ?? "",
    /do not call checkpoint_context proactively/,
  );
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns[0].contextSummary, undefined);
  assert.equal(
    snapshot.turns[1].messages.some((message) =>
      message.message.role === "assistant" &&
      message.message.toolCalls.some((toolCall) => toolCall.name === "checkpoint_context")),
    false,
  );
});

test("fails before dispatch when the Provider cannot count the final input projection", async () => {
  let streamed = false;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens() {
        throw new Error("count endpoint unavailable");
      },
      async *stream() {
        streamed = true;
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_count_failure",
    "turn_count_failure",
    "user_count_failure",
    "hello",
  );
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(streamed, false);
  assert.equal(terminal.payload.status, "failed");
  assert.equal(terminal.payload.reason, "provider_input_token_count_failed");
  assert.match(terminal.payload.details.message, /count endpoint unavailable/);
});

test("dispatches with a fallback estimate when exact Provider counting is unsupported", async () => {
  let counted = 0;
  let streamed = false;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens() {
        counted += 1;
        return undefined;
      },
      async *stream(request) {
        streamed = true;
        yield event(request.requestId, 0, "response_started");
        yield event(request.requestId, 1, "text_delta", { delta: "fallback continued" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_count_unsupported",
    "turn_count_unsupported",
    "user_count_unsupported",
    "hello",
  );
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(counted, 1);
  assert.equal(streamed, true);
  assert.equal(terminal.payload.status, "completed");
  assert.equal(terminal.payload.reason, "model_response_completed");
});

function sessionRequest(requestId, turnId, messageId, content) {
  return {
    protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    requestId,
    sessionId: "session_1",
    turnId,
    model: "model",
    prefixMessages: [{ role: "system", content: "fixed-prefix" }],
    inputMessages: [{ messageId, createdAt: NOW, message: { role: "user", content } }],
    tools: [],
    metadata: {},
  };
}

function event(requestId, sequence, kind, payload = {}) {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: NOW,
    kind,
    ...payload,
  };
}

function ordinaryToolDefinition() {
  return {
    name: "ordinary_tool",
    description: "An ordinary Tool that must remain in the stable schema.",
    inputSchema: { type: "object", properties: {} },
  };
}

function deterministicEventLogOptions() {
  let eventId = 0;
  return {
    createEventId: () => `event_${++eventId}`,
    now: () => NOW,
  };
}

function counter(prefix) {
  let value = 0;
  return () => `${prefix}_${++value}`;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Runtime fact.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
