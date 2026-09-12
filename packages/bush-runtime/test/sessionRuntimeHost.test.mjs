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
  GET_RUNTIME_USER_MESSAGE_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND,
  RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
} from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost, LogicMemoryStore, ToolRegistry, CoordinationStore } from "../dist/index.js";


function isCheckpoint(message) {
  return message.role === "assistant" && message.toolCalls.some(call => call.name === "checkpoint_context");
}
function checkpointArguments(message) {
  return message.toolCalls.find(call => call.name === "checkpoint_context").argumentsText;
}
function checkpointSummary(turn) {
  return checkpointArguments(turn.messages.find(item => item.messageId === turn.contextCheckpoint.exchangeMessageIds[0]).message);
}
function hasOrdinaryResult(messages) {
  const checkpoints = new Set(messages.filter(isCheckpoint).flatMap(m => m.toolCalls.map(c => c.id)));
  return messages.some(m => m.role === "tool" && !checkpoints.has(m.toolCallId));
}

const NOW = "2026-08-29T00:00:00.000Z";

for (const actionable of [false, true]) test(`plan handoff ${actionable ? 'still continues actionable work' : 'retains waiting verification without forcing more execution'}`, async () => {
  const coordination = new CoordinationStore();
  coordination.setPlan({ sessionId: 'session_1', expectedRevision: 0, plan: {
    protocol: 'bush.task_plan.v1', plan_id: 'waiting-plan', session_id: 'session_1', active: true, explanation: 'Await browser sign-in',
    nodes: [{ id: 'verify', step: 'Verify calendar access', status: 'waiting', waitingFor: 'User completes sign-in' },
      ...(actionable ? [{ id: 'docs', step: 'Read setup docs', status: 'pending' }] : [])],
  } });
  let calls = 0;
  const host = new InMemoryRuntimeHost({ coordinationStore: coordination, provider: { async *stream(request) {
    calls++; yield event(request.requestId, 0, 'text_delta', { delta: 'Sign in, then calendar access still needs verification.' });
    yield event(request.requestId, 1, 'response_completed', { finishReason: 'stop' });
  } } });
  const request = sessionRequest('waiting', 'waiting', 'waiting-user', 'Configure the calendar');
  request.metadata.planEnabled = true;
  const terminal = await host.runSessionTurn(request);
  assert.equal(terminal.payload.reason, actionable ? 'open_task_plan_not_resolved' : 'task_plan_waiting');
  assert.equal(calls, actionable ? 3 : 1);
  assert.equal(coordination.getPlan('session_1').plan.nodes[0].status, 'waiting');
});

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

test("records assistant thumbs as Turn feedback without crediting retrieved LEM records", async (context) => {
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
  assert.equal(stored.positive_feedback_count, 0);
  assert.equal(stored.turn_positive_feedback_count, 1);
  assert.equal(stored.reward_score, 0);
  assert.equal(stored.confidence, learned.confidence);
  assert.equal(stored.feedback_events[0].scope, "turn");
});

test('summary preparation and validation retries preserve the prefix until the checkpoint is applied', async () => {
  const requests = [];
  let attempts = 0;
  const host = new InMemoryRuntimeHost({ provider: {
    async countInputTokens(request) {
      return { inputTokens: request.messages.some(message => message.name === 'turn_context_summary') ? 100
        : request.turnId === 'third' ? 8600 : 1000, source: 'provider' };
    },
    async *stream(request) {
      requests.push(structuredClone(request));
      if (request.messages.some(message => message.name === 'context_pressure')) {
        attempts++;
        yield event(request.requestId, 0, 'tool_call_delta', { index: 0, toolCallId: `checkpoint_${attempts}`, nameDelta: 'checkpoint_context',
          argumentsDelta: JSON.stringify({ summaries: attempts === 1 ? ['missing a summary'] : ['First facts.', 'Second facts.'], active_summary: '' }) });
        yield event(request.requestId, 1, 'response_completed', { finishReason: 'tool_calls' });
        return;
      }
      yield event(request.requestId, 0, 'text_delta', { delta: `${request.turnId} complete` });
      yield event(request.requestId, 1, 'response_completed', { finishReason: 'stop' });
    },
  } });
  for (const id of ['first', 'second', 'third']) {
    const request = sessionRequest(`request_${id}`, id, `user_${id}`, 'Continue');
    request.maxOutputTokens = 1000;
    request.metadata = { contextWindowTokens: 10000 };
    assert.equal((await host.runSessionTurn(request)).payload.status, 'completed');
  }
  assert.equal(requests.length, 5);
  for (const index of [2, 3]) {
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
    assert.equal(requests[index].messages.some(message => message.name === 'context_source_boundary'), false);
  }
  const notice = requests[2].messages.at(-1);
  assert.equal(notice.name, 'context_pressure');
  const sources = notice.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.deepEqual(sources.map(source => [source.target, source.startMessage, source.endMessageExclusive]),
    [['summaries[0]', 1, 3], ['summaries[1]', 3, 5], ['not_requested', 5, 6]]);
  const observations = host.events('session_1', 'third').filter(event => event.kind === 'cache_chain_observed').map(event => event.payload);
  assert.deepEqual(observations.map(observation => observation.frozenPrefixBreak), [false, false, true]);
  assert.equal(observations[0].sharedPrefixMessages, requests[1].messages.length);
  const session = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'session_1' } });
  assert.deepEqual(session.turns.slice(0, 2).map(turn => turn.contextSummary), [undefined, undefined]);
  assert.deepEqual(JSON.parse(checkpointSummary(session.turns[2])).summaries, ['First facts.', 'Second facts.']);
  assert.ok(session.turns.every(turn => turn.messages.every(item => item.message.name !== 'context_pressure')));
});

test("forces atomic context compaction and resumes the same active Turn", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens(request) {
        return {
          inputTokens: request.messages.some((message) =>
            isCheckpoint(message))
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
            summaries: ["The user supplied a large prior payload; the Turn completed without external side effects."],
            active_summary: "",
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
    checkpointArguments(observedRequests[2].messages.find(isCheckpoint)),
    /large prior payload/,
  );
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns[0].contextSummary, undefined);
  assert.match(checkpointSummary(snapshot.turns[1]), /large prior payload/);
  assert.equal(snapshot.turns[0].messages[0].message.content.length, 20);
  assert.equal(snapshot.turns[1].messages.length, 4);
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
    true,
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
          isCheckpoint(message))) {
          return { inputTokens: 180, source: "provider" };
        }
        if (request.messages.some((message) => message.name === "context_pressure")) {
          return { inputTokens: 2_900, source: "provider" };
        }
        if (hasOrdinaryResult(request.messages)) {
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
              summaries: [],
              active_summary: "The user requested an active-loop continuation. The first observation completed successfully with no external side effect; next execute the second observation and then report completion.",
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
      ["tool", undefined],
    ],
  );
  assert.ok(isCheckpoint(continued.messages[2]));
  assert.match(checkpointArguments(continued.messages[2]), /first observation completed/);
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
  assert.match(checkpointSummary(snapshot.turns[0]), /first observation completed/);
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
    true,
    "the canonical journal retains the real maintenance exchange",
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
          isCheckpoint(message));
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
  assert.match(checkpointSummary(snapshot.turns[0]), /Five large observations/);
  assert.equal(
    snapshot.turns[0].messages.filter((message) => message.message.role === "tool").length,
    6,
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
        if (hasOrdinaryResult(request.messages)) {
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
              summaries: [],
              active_summary: checkpointRound === 1
                ? "Checkpoint one: the first observation completed; next run the second observation."
                : "Checkpoint two is cumulative: both the first and second observations completed; next return the final answer.",
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
    isCheckpoint(message));
  assert.equal(checkpoints.length, 1);
  assert.match(checkpointArguments(checkpoints[0]), /Checkpoint two is cumulative/);
  assert.doesNotMatch(checkpointArguments(checkpoints[0]), /Checkpoint one:/);
  assert.equal(finalRequest.messages.filter((message) =>
    message.name === "context_checkpoint_resume").length, 0);
  assert.equal(hasOrdinaryResult(finalRequest.messages), false);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.match(checkpointSummary(snapshot.turns[0]), /both the first and second/);
  assert.equal(snapshot.turns[0].messages.filter((message) =>
    message.message.role === "tool").length, 4);
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
        if (hasOrdinaryResult(request.messages)) {
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
        if (hasOrdinaryResult(request.messages)) {
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
  assert.match(checkpointSummary(snapshot.turns[0]), /exact completed observation/);
  assert.doesNotMatch(checkpointSummary(snapshot.turns[0]), /forged/);
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
              summaries: ["A large preceding Turn established the working context without external side effects."],
              active_summary: activeTurnId && throughMessageId
                ? "The active Turn inspected the ordinary fixture and must now finish the requested work without repeating that observation."
                : "",
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
      request.messages.some((message) => isCheckpoint(message))),
    false,
  );
  assert.equal(
    observedRequests[3].messages.some((message) => isCheckpoint(message)),
    true,
  );
  const usageEvents = host.events("session_1", "turn_calibration_2")
    .filter((candidate) => candidate.kind === "model_request_usage");
  assert.equal(usageEvents[0].payload.preflightMeasurement, "fallback_estimate");
  assert.equal(usageEvents[1].payload.preflightInputTokens >= 88_000, true);
  assert.equal(usageEvents.at(-1).payload.inputTokens, 5_000);
});

test("an earlier oversized provider response is not permission to exceed the configured window", async () => {
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

  assert.equal(terminal.payload.reason, "context_compaction_request_limit_exceeded");
  assert.equal(observedRequests.length, 1, 'the indivisible measured source must not be sent over the configured limit');
  const session = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'session_1' } });
  assert.equal(session.turns[0].messages[0].message.content, 'x'.repeat(190000));
  assert.equal(session.turns[1].contextCheckpoint, undefined);
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

for (const settlement of ["cooperative rejection", "late result", "late rejection"]) {
  test(`cancellation during input-token counting stays stopped after ${settlement}`, { timeout: 3_000 }, async () => {
    const controller = new AbortController();
    let enteredCount, resolveCount, rejectCount;
    const counting = new Promise(resolve => { enteredCount = resolve; });
    const measurement = new Promise((resolve, reject) => {
      resolveCount = resolve;
      rejectCount = reject;
    });
    let streamed = false;
    const host = new InMemoryRuntimeHost({
      provider: {
        countInputTokens(_request, { signal }) {
          if (settlement === "cooperative rejection") {
            signal.addEventListener("abort", () => rejectCount(signal.reason), { once: true });
          }
          enteredCount();
          return measurement;
        },
        async *stream() { streamed = true; },
      },
    });
    const request = sessionRequest("request_count_cancel", "turn_count_cancel", "user_count_cancel", "hello");
    request.metadata = { contextWindowTokens: 4_000 };
    const running = host.runSessionTurn(request, { signal: controller.signal });
    try {
      await counting;
      controller.abort();
      const terminal = await running;
      assert.equal(terminal.payload.status, "stopped");
      assert.equal(terminal.payload.reason, "turn_stop_requested");
      assert.equal(streamed, false);
      if (settlement === "late rejection") rejectCount(new Error("late count failure"));
      else resolveCount({ inputTokens: 9_000, source: "provider" });
      await new Promise(resolve => setImmediate(resolve));
      const events = host.events(request.sessionId, request.turnId);
      assert.equal(events.filter(event => event.kind === "turn_terminal").length, 1);
      assert.equal(events.some(event => event.kind === "provider_retry" || event.kind.startsWith("context_compaction_")), false);
      const session = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: request.sessionId } });
      assert.equal(session.turns.at(-1).status, "stopped");
    } finally {
      controller.abort();
      resolveCount(undefined);
      await running;
    }
  });
}

test("an AbortError without Turn cancellation is still a Provider count failure", async () => {
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens() { throw new DOMException("provider request aborted", "AbortError"); },
      async *stream() { assert.fail("must not dispatch after a count failure"); },
    },
  });
  const request = sessionRequest("request_count_abort_error", "turn_count_abort_error", "user_count_abort_error", "hello");
  request.metadata = { contextWindowTokens: 4_000 };
  const terminal = await host.runSessionTurn(request);
  assert.equal(terminal.payload.status, "failed");
  assert.equal(terminal.payload.reason, "provider_input_token_count_failed");
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

for (const recover of [true, false]) {
  test(`summary-only checkpoint ${recover ? "corrects malformed output and resumes" : "fails safely after bounded corrections"} without replaying Tools`, async t => {
    const root = await mkdtemp(join(tmpdir(), "cardbush-checkpoint-binding-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let executed = 0, maintenance = 0;
    const observed = [], argumentsByAttempt = [];
    const registry = new ToolRegistry().register({
      definition: ordinaryToolDefinition(),
      manifest: { effect_kind: "observation", operation: "fixture.once", risk: "low", owner: "fixture_runtime", dispatch_scope: "turn", mutating: false },
      decodeInput: input => input,
      execute: () => { executed += 1; return { fact: "A completed observation must remain in history." }; },
    });
    const host = new InMemoryRuntimeHost({
      dataRoot: root, toolRegistry: registry,
      provider: {
        async countInputTokens(request) {
          if (request.messages.some(m => isCheckpoint(m))) return { inputTokens: 100, source: "provider" };
          if (request.messages.some(m => m.name === "context_pressure")) return { inputTokens: 2900, source: "provider" };
          return { inputTokens: request.messages.some(m => m.role === "tool") ? 2860 : 100, source: "provider" };
        },
        async *stream(request) {
          observed.push(structuredClone(request));
          yield event(request.requestId, 0, "response_started");
          if (request.messages.some(m => m.name === "context_pressure")) {
            maintenance += 1;
            const args = maintenance === 1
              ? { summaries: [], active_summary: { private: "SUMMARY_TEXT_MUST_NOT_LEAK" } }
              : maintenance === 2 ? { summaries: ["unexpected preceding Turn"], active_summary: "Current verified facts." }
              : { summaries: [], active_summary: recover ? "The observation completed. Return the final answer; do not rerun it." : null };
            argumentsByAttempt.push(JSON.stringify(args));
            yield event(request.requestId, 1, "tool_call_delta", {
              index: 0, toolCallId: `checkpoint_${maintenance}`, nameDelta: "checkpoint_context", argumentsDelta: JSON.stringify(args),
            });
            yield event(request.requestId, 2, "response_completed", { finishReason: "tool_calls" });
          } else if (request.messages.some(m => isCheckpoint(m))) {
            assert.equal(request.messages.some(m => m.name === "context_checkpoint_resume"), false);
            assert.equal(hasOrdinaryResult(request.messages), false);
            yield event(request.requestId, 1, "text_delta", { delta: "Finished without repeating the observation." });
            yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
          } else {
            yield event(request.requestId, 1, "tool_call_delta", {
              index: 0, toolCallId: "before_checkpoint_once", nameDelta: "ordinary_tool", argumentsDelta: "{}",
            });
            yield event(request.requestId, 2, "response_completed", { finishReason: "tool_calls" });
          }
        },
      },
    });
    const request = sessionRequest("request_binding", "turn_binding", "user_binding", "Observe once and finish.");
    request.tools = [ordinaryToolDefinition()];
    request.maxOutputTokens = 1000;
    request.metadata = { contextWindowTokens: 4000 };
    const terminal = await host.runSessionTurn(request);
    assert.equal(terminal.payload.status, recover ? "completed" : "failed");
    assert.equal(executed, 1);
    assert.equal(maintenance, 3);
    const events = host.events("session_1", "turn_binding");
    const retries = events.filter(e => e.kind === "context_compaction_retrying");
    assert.deepEqual(retries.map(e => e.payload.diagnostics.field), ["active_summary", "summaries"]);
    assert.deepEqual(retries.map(e => e.payload.attempt), [2, 3]);
    assert.equal(retries[0].payload.diagnostics.argumentsChars, argumentsByAttempt[0].length);
    assert.equal(retries[0].payload.diagnostics.argumentsSha256.length, 64);
    assert.doesNotMatch(JSON.stringify(retries), /SUMMARY_TEXT_MUST_NOT_LEAK/);
    assert.doesNotMatch(JSON.stringify(observed.slice(2).map(r => r.messages)), /SUMMARY_TEXT_MUST_NOT_LEAK/);
    for (const item of observed) assert.deepEqual(item.tools, observed[0].tools);
    for (const index of [2, 3]) {
      assert.deepEqual(observed[index].messages.slice(0, observed[index - 1].messages.length), observed[index - 1].messages, "corrections append without changing the cache prefix");
    }
    const session = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: "session_1" } });
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0].messages.filter(e => e.message.role === "tool" && e.message.toolCallId === "before_checkpoint_once").length, 1);
    if (recover) {
      assert.match(checkpointSummary(session.turns[0]), /observation completed/);
      assert.equal(events.filter(e => e.kind === "context_compaction_completed").length, 1);
    } else {
      assert.equal(session.turns[0].contextCheckpoint, undefined);
      assert.equal(terminal.payload.details.checkpointDiagnostics.field, "active_summary");
      assert.equal(events.find(e => e.kind === "context_compaction_failed").payload.diagnostics.field, "active_summary");
      assert.equal(events.some(e => e.kind === "context_compaction_completed"), false);
    }
  });
}

test('continues after a successful checkpoint with a half-window output allowance', async () => {
  const observed = [];
  const host = new InMemoryRuntimeHost({ provider: {
    async countInputTokens(request) {
      return { inputTokens: request.messages.some(m => m.content === 'large-prior') ? 124_000 : 6_945, source: 'provider' };
    },
    async *stream(request) {
      observed.push(request);
      yield event(request.requestId, 0, 'response_started');
      if (request.messages.some(m => m.name === 'context_pressure')) {
        yield event(request.requestId, 1, 'tool_call_delta', { index: 0, toolCallId: 'checkpoint',
          nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify({ summaries: ['Prior work retained.'], active_summary: '' }) });
        yield event(request.requestId, 2, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield event(request.requestId, 1, 'text_delta', { delta: observed.length === 1 ? 'large-prior' : 'continued successfully' });
        yield event(request.requestId, 2, 'response_completed', { finishReason: 'stop' });
      }
    },
  } });
  await host.runSessionTurn(sessionRequest('seed-request', 'seed-turn', 'seed-user', 'seed'));
  const next = { ...sessionRequest('large-output', 'large-output', 'next-user', 'continue'),
    maxOutputTokens: 128_000, metadata: { contextWindowTokens: 256_000 } };
  const terminal = await host.runSessionTurn(next);
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(observed.length, 3);
  assert.equal(observed[2].maxOutputTokens, 128_000, 'does not silently reduce configured output');
  assert.match(checkpointArguments(observed[2].messages.find(isCheckpoint)), /Prior work retained/);
  assert.equal(host.events('session_1', 'large-output').filter(e => e.kind === 'context_compaction_completed').length, 1);
});

for (const [inputTokens, succeeds] of [[191_000, true], [225_000, false]]) {
  test(`uses actual input fit when no more context can be summarized (${inputTokens})`, async () => {
    let calls = 0;
    const host = new InMemoryRuntimeHost({ provider: {
      async countInputTokens() { return { inputTokens, source: 'provider' }; },
      async *stream(request) { calls++;
        yield event(request.requestId, 0, 'text_delta', { delta: 'done' });
        yield event(request.requestId, 1, 'response_completed', { finishReason: 'stop' });
      },
    } });
    const request = { ...sessionRequest('fit', 'fit', 'fit', 'continue'),
      maxOutputTokens: 32_000, metadata: { contextWindowTokens: 256_000 } };
    const terminal = await host.runSessionTurn(request);
    assert.equal(terminal.payload.status, succeeds ? 'completed' : 'failed');
    assert.equal(calls, succeeds ? 1 : 0);
    if (!succeeds) assert.equal(terminal.payload.reason, 'current_turn_context_limit_exceeded');
  });
}

test('user reference reads share the durable fact before and after commit, including guidance metadata', async () => {
  const release = Promise.withResolvers();
  const secondRelease = Promise.withResolvers();
  let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: {
    async *stream(request) {
      calls++;
      await (calls === 1 ? release.promise : secondRelease.promise);
      yield event(request.requestId, 0, 'text_delta', { delta: 'done' });
      yield event(request.requestId, 1, 'response_completed', { finishReason: 'stop' });
    },
  } });
  const request = sessionRequest('reference-request', 'reference-turn', 'reference-user', 'authored plus resolved facts');
  request.inputMessages[0].metadata = { composerReferenceContent: 'authored' };
  const running = host.runSessionTurn(request);
  const readUser = (messageId, sessionId = 'session_1') => host.sendCommand({ kind: GET_RUNTIME_USER_MESSAGE_COMMAND,
    payload: { sessionId, turnId: 'reference-turn', messageId } });
  try {
    await waitFor(() => calls === 1);
    assert.equal((await readUser('reference-user')).message.content, 'authored plus resolved facts');
    assert.equal((await readUser('reference-user')).metadata.composerReferenceContent, 'authored');
    assert.equal(await readUser('reference-user', 'wrong-session'), null);
    assert.equal(await readUser('missing'), null);
    await host.sendCommand({ kind: ENQUEUE_RUNTIME_GUIDANCE_COMMAND, payload: {
      protocol: BUSH_RUNTIME_GUIDANCE_PROTOCOL, sessionId: 'session_1', turnId: 'reference-turn', messageId: 'reference-guidance',
      createdAt: NOW, content: 'guidance plus selected source', metadata: { composerReferenceContent: 'guidance' },
    } });
    release.resolve();
    await waitFor(() => calls === 2);
    assert.equal((await readUser('reference-guidance')).metadata.composerReferenceContent, 'guidance');
  } finally { release.resolve(); secondRelease.resolve(); await running; }
  assert.equal((await readUser('reference-user')).metadata.composerReferenceContent, 'authored');
  assert.equal((await readUser('reference-guidance')).message.content, 'guidance plus selected source');
  await host.sendCommand({ kind: SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND, payload: { sessionId: 'session_1', messageIds: ['reference-user'], reason: 'edited' } });
  assert.equal(await readUser('reference-user'), null, 'a durable checkpoint cannot resurrect a replaced user instruction');
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
