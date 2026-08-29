import assert from 'node:assert/strict';

import {
  BUSH_RUNTIME_EVENT_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
} from '@cardbush/bush-protocol';
import {
  ProductRuntimeConversationBackend,
} from '../dist-electron/productRuntimeConversationBackend.mjs';

class FakeRuntimeBridge {
  #listeners = new Set();
  #subscription;
  #turnResolve;
  #resolvePermission;
  permissionRequested = new Promise((resolve) => { this.#resolvePermission = resolve; });
  providerConfigured = false;
  lastTurnRequest;

  onStreamFrame(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startStream(message) { this.#subscription = message.subscriptionId; }
  async stopStream() {}
  async cancelOperation() {}

  async command(message) {
    const { kind, payload } = message.command;
    if (kind === 'runtime.upsert_provider_binding') {
      this.providerConfigured = true;
      return success(message, {
        protocol: 'bush.provider_binding_result.v1',
        status: 'configured',
        binding: {
          protocol: 'bush.provider_binding_ref.v1',
          bindingId: payload.bindingId,
          revision: 'revision-1',
        },
      });
    }
    if (kind === 'runtime.get_tool_catalog_details') return success(message, []);
    if (kind === 'runtime.run_session_turn') {
      this.lastTurnRequest = payload;
      const identity = identityFrom(payload);
      this.#event(identity, 0, 'permission_requested', {
        permissionId: 'permission_1',
        toolCallId: 'tool_1',
        reason: 'write requested',
        actions: ['write'],
        resources: ['C:\\workspace\\file.txt'],
        requestedCapabilityIds: ['cap_write'],
      });
      this.#resolvePermission();
      return await new Promise((resolve) => { this.#turnResolve = resolve; });
    }
    if (kind === 'runtime.answer_permission') {
      const identity = identityFrom(this.lastTurnRequest);
      this.#event(identity, 1, 'permission_answered', {
        permissionId: 'permission_1',
        toolCallId: 'tool_1',
        answerId: payload.answerId,
        grantedCapabilityIds: payload.grantedCapabilityIds,
      });
      this.#event(identity, 2, 'assistant_segment_completed', {
        messageId: 'assistant_1',
        segmentId: 'segment_1',
        ordinal: 0,
        content: 'completed through Runtime',
      });
      const terminal = event(identity, 3, 'turn_terminal', {
        status: 'completed',
        reason: 'completed',
        details: {},
        finalMessageId: 'assistant_1',
      });
      this.#eventRaw(terminal);
      this.#end();
      this.#turnResolve(success({ operationId: 'ignored' }, terminal));
      return success(message, payload);
    }
    throw new Error(`unexpected command: ${kind}`);
  }

  #event(identity, sequence, kind, payload) {
    this.#eventRaw(event(identity, sequence, kind, payload));
  }

  #eventRaw(value) {
    const message = {
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'stream_frame',
      subscriptionId: this.#subscription,
      frame: { kind: 'event', event: value },
    };
    for (const listener of this.#listeners) listener(message);
  }

  #end() {
    const message = {
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'stream_frame',
      subscriptionId: this.#subscription,
      frame: { kind: 'end' },
    };
    for (const listener of this.#listeners) listener(message);
  }
}

function success(message, result) {
  return {
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: 'command_response',
    operationId: message.operationId,
    ok: true,
    result,
  };
}

function identityFrom(request) {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
  };
}

function event(identity, sequence, kind, payload) {
  return {
    protocol: BUSH_RUNTIME_EVENT_PROTOCOL,
    eventId: `event_${sequence}`,
    sequence,
    requestId: identity.requestId,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    createdAt: '2026-08-29T00:00:00.000Z',
    kind,
    payload,
  };
}

function envelope(text) {
  return {
    platform: 'discord',
    sessionId: 'discord:channel:user',
    userId: 'user',
    channelId: 'channel',
    text,
    rawEvent: {},
  };
}

async function main() {
  const bridge = new FakeRuntimeBridge();
  const backend = new ProductRuntimeConversationBackend({
    bridge,
    modelConfig: () => ({
      bindingId: 'default-model',
      provider: 'test',
      model: 'test-model',
      apiKey: 'secret',
    }),
    policy: () => ({
      permissionMode: 'task_free',
      disabledTools: [],
      allowedSkills: [],
      subagentEnabled: true,
    }),
    createId: (() => {
      let value = 0;
      return (prefix) => `${prefix}_${++value}`;
    })(),
    localDate: () => '2026-08-29',
  });

  const seenPermissions = [];
  const firstReply = backend.respond(envelope('write this'), {
    onPermissionRequest: (request) => { seenPermissions.push(request); },
  });
  await bridge.permissionRequested;
  await eventually(() => seenPermissions.length === 1);
  assert.equal(seenPermissions.length, 1);
  assert.deepEqual(seenPermissions[0].requestedCapabilityIds, ['cap_write']);

  const permissionReply = await backend.respond(envelope('1'));
  assert.equal(permissionReply.metadata.decision, 'allow_once');
  assert.equal(permissionReply.text, '已提交权限授权，原任务将继续执行。');

  const result = await firstReply;
  assert.equal(result.text, 'completed through Runtime');
  assert.equal(bridge.providerConfigured, true);
  assert.equal(bridge.lastTurnRequest.prefixMessages[0].role, 'system');
  assert.equal(bridge.lastTurnRequest.inputMessages[0].message.name, 'discord_bot_user');
  assert.equal(bridge.lastTurnRequest.metadata.permissionMode, 'task_free');

  process.stdout.write('product Runtime conversation contract passed\n');
}

await main();

async function eventually(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not reached');
}
