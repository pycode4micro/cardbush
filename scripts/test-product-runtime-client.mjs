import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(
  repositoryRoot,
  'packages',
  'bush-protocol',
  'reference-fixtures',
  'single-turn-stream.v1.json',
);
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'cardbush-runtime-client-'),
);

try {
  const buildResult = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: temporaryDirectory,
      emptyOutDir: true,
      lib: {
        entry: path.join(repositoryRoot, 'src', 'runtime-client', 'index.ts'),
        formats: ['es'],
        fileName: 'runtime-client',
      },
    },
  });

  const buildOutputs = Array.isArray(buildResult) ? buildResult : [buildResult];
  const entryChunk = buildOutputs
    .flatMap((output) => output.output)
    .find((output) => output.type === 'chunk' && output.isEntry);
  assert.ok(entryChunk, 'Vite did not return a Runtime Client entry chunk.');
  const runtimeClientModule = await import(
    pathToFileURL(path.join(temporaryDirectory, entryChunk.fileName)).href
  );
  const fixtureInput = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { client, fixture } =
    runtimeClientModule.createRuntimeFixtureClient(fixtureInput);
  const capabilities = await client.getCapabilities();

  assert.equal(capabilities.protocol, 'bush.runtime_capabilities.v1');
  assert.equal(capabilities.eventProtocol, 'bush.runtime_event.v1');
  assert.ok(capabilities.features.includes('reasoning_segments'));
  assert.ok(capabilities.features.includes('assistant_segments'));

  const typedSessionClient = new runtimeClientModule.ProtocolRuntimeClient(
    createSessionCommandTransport(),
  );
  assert.equal((await typedSessionClient.getSession('session_typed')).turns.length, 1);
  assert.deepEqual(
    (await typedSessionClient.assembleSessionContext({
      sessionId: 'session_typed',
      currentMessages: [{ role: 'user', content: 'current' }],
    })).messages.map((message) => message.content),
    ['stored', 'current'],
  );
  assert.equal(
    (await typedSessionClient.runSessionTurn(sessionTurnRequest())).kind,
    'turn_terminal',
  );

  const goalTurns = [];
  let goalRead = 0;
  const goalRunner = new runtimeClientModule.GoalContinuationRunner({
    client: {
      async createGoal(input) {
        return goalState(input, 'active', 1);
      },
      async getGoal(sessionId) {
        goalRead += 1;
        return goalState(
          { goalId: 'goal_1', sessionId, objective: 'finish' },
          goalRead === 1 ? 'active' : 'complete',
          goalRead + 1,
        );
      },
    },
    async runTurn(request) {
      goalTurns.push(request);
      return terminalEvent(request, 'completed');
    },
    createId: sequentialGoalId(),
  });
  const goalResult = await goalRunner.run({
    goalId: 'goal_1',
    objective: 'finish',
    initialTurn: sessionTurnRequest(),
    continuationPrompt: 'Check the objective; continue if it is not complete.',
  });
  assert.equal(goalResult.goal.status, 'complete');
  assert.equal(goalResult.turns.length, 2);
  assert.equal(
    goalTurns[1].inputMessages[0].message.content,
    'Check the objective; continue if it is not complete.',
  );
  assert.notEqual(goalTurns[0].turnId, goalTurns[1].turnId);

  const projection = new runtimeClientModule.RuntimeTurnProjection();
  const eventKinds = [];
  let view = projection.snapshot();

  for await (const event of client.events({
    sessionId: 'session_fixture_001',
    turnId: 'turn_fixture_001',
  })) {
    eventKinds.push(event.kind);
    view = projection.apply(event);
    if (event.kind === 'assistant_segment_completed') {
      assert.equal(view.phase, 'running');
      assert.equal(view.terminal, undefined);
    }
  }

  assert.deepEqual(
    eventKinds,
    fixture.events.map(({ event }) => event.kind),
  );
  assert.equal(view.phase, 'completed');
  assert.equal(view.terminal?.reason, 'assistant_response_completed');
  assert.equal(
    view.reasoningSegments[0]?.content,
    '检查请求与可用事实。',
  );
  assert.equal(
    view.assistantSegments[0]?.content,
    '首轮 Runtime 流已接通。',
  );
  assert.notEqual(
    view.reasoningSegments[0]?.segmentId,
    view.assistantSegments[0]?.segmentId,
  );

  const beforeDuplicate = projection.snapshot();
  const afterDuplicate = projection.apply(fixture.events.at(-1).event);
  assert.deepEqual(afterDuplicate, beforeDuplicate);

  const invalidFixture = structuredClone(fixtureInput);
  invalidFixture.events[0].event.protocol = 'invalid.protocol';
  assert.throws(() =>
    runtimeClientModule.createRuntimeFixtureClient(invalidFixture),
  );

  const storeSetup = runtimeClientModule.createRuntimeFixtureClient(fixtureInput);
  const store = new runtimeClientModule.RuntimeTurnStore(storeSetup.client);
  const observedStoreStates = [];
  const unsubscribe = store.subscribe(() => {
    observedStoreStates.push(store.getSnapshot().streamState);
  });
  await store.discoverCapabilities();
  await store.start({
    sessionId: 'session_fixture_001',
    turnId: 'turn_fixture_001',
  });
  unsubscribe();
  assert.equal(store.getSnapshot().streamState, 'settled');
  assert.equal(store.getSnapshot().eventCount, fixture.events.length);
  assert.ok(observedStoreStates.includes('discovering'));
  assert.ok(observedStoreStates.includes('streaming'));
  assert.ok(observedStoreStates.includes('settled'));

  const incompleteFixture = structuredClone(fixtureInput);
  incompleteFixture.events.pop();
  const incompleteSetup =
    runtimeClientModule.createRuntimeFixtureClient(incompleteFixture);
  const incompleteStore = new runtimeClientModule.RuntimeTurnStore(
    incompleteSetup.client,
  );
  await assert.rejects(
    incompleteStore.start({
      sessionId: 'session_fixture_001',
      turnId: 'turn_fixture_001',
    }),
    /closed before turn_terminal/,
  );
  assert.equal(incompleteStore.getSnapshot().streamState, 'error');

  const liveBridge = createLiveRuntimeBridge();
  const liveSession = new runtimeClientModule.ElectronRuntimeSession(
    liveBridge,
    { createId: sequentialId('live') },
  );
  const liveCapabilities = await liveSession.discoverCapabilities();
  assert.equal(liveCapabilities.hostId, 'electron-live-test');
  const providerBinding = await liveSession.configureProvider({
    protocol: 'bush.provider_binding_config.v1',
    bindingId: 'product_model_config',
    adapter: 'openai_responses',
    apiKey: 'product-test-secret',
    baseURL: 'https://provider.invalid/v1',
  });
  assert.equal(providerBinding.status, 'configured');
  assert.equal(JSON.stringify(providerBinding).includes('product-test-secret'), false);
  assert.equal(
    (await liveSession.removeProvider('product_model_config')).status,
    'removed',
  );
  const liveResult = await liveSession.run(modelRequest('live'));
  assert.equal(liveResult.terminal.status, 'failed');
  assert.equal(liveResult.terminal.reason, 'runtime_provider_not_configured');
  assert.equal(liveSession.store.getSnapshot().eventCount, 3);
  assert.equal(liveResult.commandTerminal?.kind, 'turn_terminal');
  const permissionAnswer = await liveSession.answerPermission({
    protocol: 'bush.runtime_permission_answer.v1',
    permissionId: 'permission_live',
    answerId: 'answer_live',
    decision: 'allow_once',
    grantedCapabilityIds: ['capability.files.write'],
  });
  assert.deepEqual(permissionAnswer.grantedCapabilityIds, [
    'capability.files.write',
  ]);
  assert.throws(() => liveSession.answerPermission({
    protocol: 'bush.runtime_permission_answer.v1',
    permissionId: 'permission_invalid',
    answerId: 'answer_invalid',
    decision: 'allow_once',
    grantedCapabilityIds: [],
  }));

  const lifecycleProjection = new runtimeClientModule.RuntimeTurnProjection();
  const lifecycleEvents = toolPermissionLifecycleEvents();
  for (const event of lifecycleEvents) lifecycleProjection.apply(event);
  const lifecycleView = lifecycleProjection.snapshot();
  assert.equal(lifecycleView.tools.length, 1);
  assert.equal(lifecycleView.tools[0].phase, 'completed');
  assert.deepEqual(lifecycleView.tools[0].receiptIds, ['receipt_write_1']);
  assert.deepEqual(lifecycleView.tools[0].executionFactIds, ['fact_write_1']);
  assert.deepEqual(lifecycleView.tools[0].workspaceChangeIds, ['change_write_1']);
  assert.equal(lifecycleView.permissions[0].phase, 'answered');
  assert.deepEqual(lifecycleView.permissions[0].actions, ['write']);
  assert.deepEqual(lifecycleView.permissions[0].resources, ['workspace/file.txt']);
  assert.deepEqual(lifecycleView.permissions[0].grantedCapabilityIds, [
    'capability.files.write',
  ]);
  const deniedAnswer = await liveSession.answerPermission({
    protocol: 'bush.runtime_permission_answer.v1',
    permissionId: 'permission_deny',
    answerId: 'answer_deny',
    decision: 'deny',
    grantedCapabilityIds: [],
  });
  assert.equal(deniedAnswer.decision, 'deny');

  const rejectedProjection = new runtimeClientModule.RuntimeTurnProjection();
  for (const event of permissionRejectedEvents()) rejectedProjection.apply(event);
  assert.equal(rejectedProjection.snapshot().permissions[0].phase, 'rejected');
  assert.equal(rejectedProjection.snapshot().tools[0].phase, 'failed');
  assert.equal(
    rejectedProjection.snapshot().tools[0].error.code,
    'permission_rejected',
  );

  const cancelledProjection = new runtimeClientModule.RuntimeTurnProjection();
  for (const event of permissionCancelledEvents()) cancelledProjection.apply(event);
  assert.equal(cancelledProjection.snapshot().permissions[0].phase, 'cancelled');
  assert.equal(cancelledProjection.snapshot().tools[0].phase, 'cancelled');

  const cancellableBridge = createLiveRuntimeBridge({ waitForCancellation: true });
  const cancellableSession = new runtimeClientModule.ElectronRuntimeSession(
    cancellableBridge,
    { createId: sequentialId('cancel') },
  );
  const cancelledRun = cancellableSession.run(modelRequest('cancel'));
  await until(() => cancellableSession.store.getSnapshot().eventCount === 2);
  cancellableSession.stop();
  const cancelledResult = await cancelledRun;
  assert.equal(cancelledResult.terminal.status, 'stopped');
  assert.equal(cancelledResult.terminal.reason, 'user_stop_requested');
  assert.ok(cancelledResult.commandError);
  assert.equal(cancellableSession.store.getSnapshot().streamState, 'settled');

  console.log('Product Runtime Client contract passed.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function createLiveRuntimeBridge(options = {}) {
  const listeners = new Set();
  const subscriptions = new Map();
  const operations = new Map();
  const emit = (message) => {
    for (const listener of listeners) listener(message);
  };
  const emitFrame = (subscriptionId, frame) => emit({
    protocol: 'bush.runtime_ipc.v1',
    type: 'stream_frame',
    subscriptionId,
    frame,
  });
  const response = (operationId, result) => ({
    protocol: 'bush.runtime_ipc.v1',
    type: 'command_response',
    operationId,
    ok: true,
    result,
  });
  const event = (request, sequence, kind, payload) => ({
    protocol: 'bush.runtime_event.v1',
    eventId: `event_${request.turnId}_${sequence}`,
    sequence,
    requestId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    createdAt: `2026-08-29T00:00:0${sequence}.000Z`,
    kind,
    payload,
  });

  return {
    async command(message) {
      if (message.command.kind === 'runtime.get_capabilities') {
        return response(message.operationId, {
          protocol: 'bush.runtime_capabilities.v1',
          hostId: 'electron-live-test',
          runtimeVersion: '0.1.0',
          eventProtocol: 'bush.runtime_event.v1',
          supportedEvents: ['turn_accepted', 'turn_started', 'turn_terminal'],
          supportedCommands: [
            'runtime.get_capabilities',
            'runtime.run_model_turn',
            'runtime.upsert_provider_binding',
            'runtime.remove_provider_binding',
          ],
          features: ['turn_stream'],
        });
      }
      if (message.command.kind === 'runtime.answer_permission') {
        return response(message.operationId, message.command.payload);
      }
      if (message.command.kind === 'runtime.upsert_provider_binding') {
        return response(message.operationId, {
          protocol: 'bush.provider_binding_result.v1',
          status: 'configured',
          binding: {
            bindingId: message.command.payload.bindingId,
            revision: 'product_revision_1',
          },
        });
      }
      if (message.command.kind === 'runtime.remove_provider_binding') {
        return response(message.operationId, {
          protocol: 'bush.provider_binding_result.v1',
          status: 'removed',
          bindingId: message.command.payload.bindingId,
        });
      }

      const request = message.command.payload;
      const subscriptionId = subscriptions.get(request.turnId);
      assert.ok(subscriptionId, 'product must subscribe before dispatching a Turn');
      emitFrame(subscriptionId, {
        kind: 'event',
        event: event(request, 1, 'turn_accepted', { status: 'accepted' }),
      });
      emitFrame(subscriptionId, {
        kind: 'event',
        event: event(request, 2, 'turn_started', { status: 'running' }),
      });

      if (options.waitForCancellation) {
        return new Promise((resolve) => {
          operations.set(message.operationId, { request, subscriptionId, resolve });
        });
      }

      const terminal = event(request, 3, 'turn_terminal', {
        status: 'failed',
        reason: 'runtime_provider_not_configured',
        details: {},
      });
      emitFrame(subscriptionId, { kind: 'event', event: terminal });
      emitFrame(subscriptionId, { kind: 'end' });
      return response(message.operationId, terminal);
    },
    async startStream(message) {
      subscriptions.set(message.request.turnId, message.subscriptionId);
    },
    async stopStream(message) {
      for (const [turnId, subscriptionId] of subscriptions) {
        if (subscriptionId === message.subscriptionId) subscriptions.delete(turnId);
      }
    },
    async cancelOperation(message) {
      const operation = operations.get(message.operationId);
      if (!operation) return;
      operations.delete(message.operationId);
      const terminal = event(operation.request, 3, 'turn_terminal', {
        status: 'stopped',
        reason: 'user_stop_requested',
        details: {},
      });
      emitFrame(operation.subscriptionId, { kind: 'event', event: terminal });
      emitFrame(operation.subscriptionId, { kind: 'end' });
      operation.resolve({
        protocol: 'bush.runtime_ipc.v1',
        type: 'command_response',
        operationId: message.operationId,
        ok: false,
        error: {
          protocol: 'bush.runtime_error.v1',
          code: 'operation_cancelled',
          message: 'The Runtime operation was cancelled.',
          retryable: false,
          details: {},
          requestId: message.operationId,
        },
      });
    },
    onStreamFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sequentialId(prefix) {
  let next = 0;
  return () => `${prefix}_${++next}`;
}

function modelRequest(suffix) {
  return {
    protocol: 'bush.model_request.v1',
    requestId: `request_${suffix}`,
    sessionId: `session_${suffix}`,
    turnId: `turn_${suffix}`,
    model: 'unconfigured-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    metadata: {},
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the product Runtime state.');
}

function toolPermissionLifecycleEvents() {
  const base = (sequence, kind, payload) => ({
    protocol: 'bush.runtime_event.v1',
    eventId: `event_lifecycle_${sequence}`,
    sequence,
    requestId: 'request_lifecycle',
    sessionId: 'session_lifecycle',
    turnId: 'turn_lifecycle',
    createdAt: `2026-08-29T00:01:0${sequence}.000Z`,
    kind,
    payload,
  });
  const tool = {
    toolCallId: 'tool_write_1',
    toolName: 'workspace_write',
    ordinal: 0,
    assistantMessageId: 'message_assistant_1',
    display: { title: 'Update file', summary: 'workspace/file.txt' },
  };
  return [
    base(1, 'tool_queued', tool),
    base(2, 'permission_requested', {
      permissionId: 'permission_write_1',
      toolCallId: tool.toolCallId,
      reason: 'The Action Manifest requires workspace write access.',
      actions: ['write'],
      resources: ['workspace/file.txt'],
      requestedCapabilityIds: ['capability.files.write'],
    }),
    base(3, 'permission_answered', {
      permissionId: 'permission_write_1',
      toolCallId: tool.toolCallId,
      answerId: 'answer_write_1',
      grantedCapabilityIds: ['capability.files.write'],
    }),
    base(4, 'tool_running', tool),
    base(5, 'tool_completed', {
      ...tool,
      receiptIds: ['receipt_write_1'],
      executionFactIds: ['fact_write_1'],
      artifactIds: [],
      workspaceChangeIds: ['change_write_1'],
    }),
  ];
}

function permissionRejectedEvents() {
  const [queued, requested] = toolPermissionLifecycleEvents();
  const identity = eventIdentity('rejected');
  const tool = queued.payload;
  return [
    { ...queued, ...identity, eventId: 'event_rejected_1', sequence: 1 },
    { ...requested, ...identity, eventId: 'event_rejected_2', sequence: 2 },
    lifecycleEvent(identity, 3, 'permission_rejected', {
      permissionId: requested.payload.permissionId,
      toolCallId: tool.toolCallId,
      reason: 'The user denied this action.',
    }),
    lifecycleEvent(identity, 4, 'tool_failed', {
      ...tool,
      receiptIds: [],
      executionFactIds: [],
      artifactIds: [],
      workspaceChangeIds: [],
      error: {
        code: 'permission_rejected',
        message: 'The requested permission was rejected.',
        details: {},
      },
    }),
  ];
}

function permissionCancelledEvents() {
  const [queued, requested] = toolPermissionLifecycleEvents();
  const identity = eventIdentity('cancelled');
  const tool = queued.payload;
  return [
    { ...queued, ...identity, eventId: 'event_cancelled_1', sequence: 1 },
    { ...requested, ...identity, eventId: 'event_cancelled_2', sequence: 2 },
    lifecycleEvent(identity, 3, 'permission_cancelled', {
      permissionId: requested.payload.permissionId,
      toolCallId: tool.toolCallId,
      reason: 'The permission request was cancelled.',
    }),
    lifecycleEvent(identity, 4, 'tool_cancelled', {
      ...tool,
      reason: 'permission_request_cancelled',
    }),
  ];
}

function eventIdentity(suffix) {
  return {
    requestId: `request_${suffix}`,
    sessionId: `session_${suffix}`,
    turnId: `turn_${suffix}`,
  };
}

function lifecycleEvent(identity, sequence, kind, payload) {
  return {
    protocol: 'bush.runtime_event.v1',
    eventId: `event_${identity.turnId}_${sequence}`,
    sequence,
    ...identity,
    createdAt: `2026-08-29T00:02:0${sequence}.000Z`,
    kind,
    payload,
  };
}

function createSessionCommandTransport() {
  const committedTurn = {
    turnId: 'turn_typed_1',
    turnSequence: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    status: 'completed',
    reason: 'model_response_completed',
    messages: [{
      messageId: 'message_typed_1',
      turnId: 'turn_typed_1',
      turnSequence: 1,
      messageIndex: 0,
      createdAt: '2026-08-29T00:00:00.000Z',
      message: { role: 'user', content: 'stored' },
    }],
    usage: {},
  };
  return {
    async *openEventStream() {},
    async sendCommand(command) {
      if (command.kind === 'runtime.get_session') {
        return {
          protocol: 'bush.session_snapshot.v1',
          sessionId: 'session_typed',
          revision: 2,
          createdAt: '2026-08-29T00:00:00.000Z',
          updatedAt: '2026-08-29T00:00:01.000Z',
          turns: [committedTurn],
          supersededMessageIds: [],
        };
      }
      if (command.kind === 'runtime.assemble_session_context') {
        return {
          protocol: 'bush.context_snapshot.v1',
          sessionId: 'session_typed',
          sessionRevision: 2,
          throughTurnSequence: 1,
          sourceMessageIds: ['message_typed_1'],
          messages: [
            committedTurn.messages[0].message,
            ...command.payload.currentMessages,
          ],
        };
      }
      if (command.kind === 'runtime.run_session_turn') {
        return {
          protocol: 'bush.runtime_event.v1',
          eventId: 'event_typed_terminal',
          sequence: 1,
          requestId: command.payload.requestId,
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          createdAt: '2026-08-29T00:00:02.000Z',
          kind: 'turn_terminal',
          payload: {
            status: 'completed',
            reason: 'model_response_completed',
            details: {},
          },
        };
      }
      throw new Error(`Unexpected command ${command.kind}`);
    },
  };
}

function sessionTurnRequest() {
  return {
    protocol: 'bush.session_turn_request.v1',
    requestId: 'request_typed_2',
    sessionId: 'session_typed',
    turnId: 'turn_typed_2',
    model: 'model',
    prefixMessages: [],
    inputMessages: [{
      messageId: 'message_typed_2',
      message: { role: 'user', content: 'next' },
    }],
    tools: [],
  };
}

function goalState(input, status, revision) {
  return {
    protocol: 'bush.goal.v1',
    goalId: input.goalId,
    sessionId: input.sessionId,
    objective: input.objective,
    status,
    statusReason: '',
    consumedTokens: 0,
    linkedA2ATaskIds: [],
    revision,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...(status === 'active' ? {} : { completedAt: '2026-08-29T00:00:00.000Z' }),
  };
}

function terminalEvent(request, status) {
  return {
    protocol: 'bush.runtime_event.v1',
    eventId: `event_${request.turnId}`,
    sequence: 1,
    requestId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    createdAt: '2026-08-29T00:00:00.000Z',
    kind: 'turn_terminal',
    payload: {
      status,
      reason: 'model_response_completed',
      details: {},
    },
  };
}

function sequentialGoalId() {
  let id = 0;
  return (kind) => `${kind}_goal_${++id}`;
}
