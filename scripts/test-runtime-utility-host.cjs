const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { app, BrowserWindow, ipcMain } = require('electron');

void run().catch((error) => {
  console.error(error);
  app.exit(1);
});

async function run() {
  const {
    BUSH_MODEL_REQUEST_PROTOCOL,
    BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
    BUSH_RUNTIME_IPC_PROTOCOL,
    BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    GET_RUNTIME_CAPABILITIES_COMMAND,
    GET_RUNTIME_SESSION_COMMAND,
    REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
    RUN_RUNTIME_SESSION_TURN_COMMAND,
    UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  } = await import('@cardbush/bush-protocol');
  const { RUN_MODEL_TURN_COMMAND } = await import('@cardbush/bush-runtime');
  const { ElectronRuntimeTransport } = await import(
    '@cardbush/bush-runtime-electron'
  );
  const repositoryRoot = path.resolve(__dirname, '..');
  const runtimeStateRoot = mkdtempSync(
    path.join(tmpdir(), 'cardbush-runtime-utility-'),
  );

  await app.whenReady();
  const {
    RuntimeUtilityProcessController,
    registerRuntimeHostIpc,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, 'dist-electron', 'runtimeHostController.mjs'),
    ).href
  );
  const controller = new RuntimeUtilityProcessController({
    modulePath: path.join(
      repositoryRoot,
      'dist-electron',
      'runtimeHostWorker.mjs',
    ),
    env: {
      ...withoutProviderConfiguration(process.env),
      CARDBUSH_RUNTIME_STATE_ROOT: runtimeStateRoot,
    },
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });

  try {
    const ready = await within(controller.start(), 15_000, 'Runtime Host startup');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.capabilities.eventProtocol, 'bush.runtime_event.v1');
    assert.ok(ready.capabilities.features.includes('durable_restart_recovery'));
    assert.ok(ready.capabilities.features.includes('durable_sessions'));
    assert.ok(
      ready.capabilities.supportedCommands.includes(
        UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
      ),
    );

    const capabilityResponse = await within(
      controller.command({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: 'command',
        operationId: 'operation_capabilities',
        command: { kind: GET_RUNTIME_CAPABILITIES_COMMAND, payload: {} },
      }),
      15_000,
      'Runtime capability command',
    );
    assert.equal(capabilityResponse.type, 'command_response');
    assert.equal(capabilityResponse.ok, true);
    const configuredProvider = await controller.command({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'command',
      operationId: 'operation_configure_provider',
      command: {
        kind: UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
        payload: {
          protocol: BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
          bindingId: 'utility_provider',
          adapter: 'openai_compatible',
          apiKey: 'utility-test-secret',
          baseURL: 'https://provider.invalid/v1',
        },
      },
    });
    assert.equal(configuredProvider.ok, true);
    assert.equal(configuredProvider.result.status, 'configured');
    assert.equal(
      JSON.stringify(configuredProvider.result).includes('utility-test-secret'),
      false,
    );
    const mismatchResponse = await controller.command({
      protocol: 'bush.runtime_ipc.v2',
      type: 'command',
      operationId: 'operation_mismatch',
      command: { kind: GET_RUNTIME_CAPABILITIES_COMMAND, payload: {} },
    });
    assert.equal(mismatchResponse.ok, false);
    assert.equal(mismatchResponse.error.code, 'protocol_version_mismatch');

    const frames = [];
    let finishStream;
    const streamComplete = new Promise((resolve) => {
      finishStream = resolve;
    });
    const removeFrameListener = controller.onStreamFrame((message) => {
      if (
        message.type !== 'stream_frame' ||
        message.subscriptionId !== 'subscription_turn'
      ) {
        return;
      }
      frames.push(message.frame);
      if (message.frame.kind === 'end' || message.frame.kind === 'error') {
        finishStream();
      }
    });
    await controller.startStream({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'start_stream',
      subscriptionId: 'subscription_turn',
      request: { sessionId: 'session_live', turnId: 'turn_live' },
    });
    const turnResponse = await within(
      controller.command({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: 'command',
        operationId: 'operation_turn',
        command: {
          kind: RUN_MODEL_TURN_COMMAND,
          payload: {
            protocol: BUSH_MODEL_REQUEST_PROTOCOL,
            requestId: 'request_live',
            sessionId: 'session_live',
            turnId: 'turn_live',
            model: 'unconfigured-model',
            messages: [{ role: 'user', content: 'hello' }],
            tools: [],
          },
        },
      }),
      15_000,
      'Runtime Turn command',
    );
    await within(streamComplete, 15_000, 'Runtime Turn stream');
    removeFrameListener();

    assert.equal(turnResponse.type, 'command_response');
    assert.equal(turnResponse.ok, true);
    assert.equal(turnResponse.result.kind, 'turn_terminal');
    assert.equal(turnResponse.result.payload.status, 'failed');
    assert.equal(
      turnResponse.result.payload.reason,
      'runtime_provider_not_configured',
    );
    assert.deepEqual(
      frames
        .filter((frame) => frame.kind === 'event')
        .map((frame) => frame.event.kind),
      [
        'turn_accepted',
        'turn_started',
        'cache_chain_observed',
        'turn_terminal',
      ],
    );
    assert.equal(frames.at(-1)?.kind, 'end');

    const transport = new ElectronRuntimeTransport({
      command: (message) => controller.command(message),
      startStream: (message) => controller.startStream(message),
      stopStream: (message) => controller.stopStream(message),
      cancelOperation: (message) => controller.cancelOperation(message),
      onStreamFrame: (listener) => controller.onStreamFrame(listener),
    });
    const transportCapabilities = await transport.sendCommand({
      kind: GET_RUNTIME_CAPABILITIES_COMMAND,
      payload: {},
    });
    assert.equal(transportCapabilities.eventProtocol, 'bush.runtime_event.v1');

    const transportedEventsPromise = collect(
      transport.openEventStream({
        sessionId: 'session_transport',
        turnId: 'turn_transport',
      }),
    );
    const transportedTerminal = await transport.sendCommand({
      kind: RUN_MODEL_TURN_COMMAND,
      payload: {
        protocol: BUSH_MODEL_REQUEST_PROTOCOL,
        requestId: 'request_transport',
        sessionId: 'session_transport',
        turnId: 'turn_transport',
        model: 'unconfigured-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      },
    });
    const transportedEvents = await within(
      transportedEventsPromise,
      15_000,
      'Electron RuntimeTransport stream',
    );
    assert.equal(transportedTerminal.kind, 'turn_terminal');
    assert.deepEqual(
      transportedEvents.map((event) => event.kind),
      [
        'turn_accepted',
        'turn_started',
        'cache_chain_observed',
        'turn_terminal',
      ],
    );
    assert.ok(readdirSync(path.join(runtimeStateRoot, 'events')).length >= 2);
    assert.deepEqual(readdirSync(path.join(runtimeStateRoot, 'checkpoints')), []);
    const sessionTurn = await controller.command({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'command',
      operationId: 'operation_session_turn',
      command: {
        kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
        payload: {
          protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
          requestId: 'request_session_turn',
          sessionId: 'session_durable',
          turnId: 'turn_durable',
          model: 'unconfigured-model',
          prefixMessages: [{ role: 'system', content: 'fixed' }],
          inputMessages: [{
            messageId: 'user_durable',
            message: { role: 'user', content: 'persist me' },
          }],
          tools: [],
        },
      },
    });
    assert.equal(sessionTurn.ok, true);
    assert.equal(sessionTurn.result.payload.status, 'failed');
    assert.equal(readdirSync(path.join(runtimeStateRoot, 'sessions')).length, 1);
    const removedProvider = await controller.command({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'command',
      operationId: 'operation_remove_provider',
      command: {
        kind: REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
        payload: { bindingId: 'utility_provider' },
      },
    });
    assert.equal(removedProvider.ok, true);
    assert.equal(removedProvider.result.status, 'removed');

    let testWindow;
    const unregisterIpc = registerRuntimeHostIpc(
      ipcMain,
      controller,
      (sender) => testWindow != null && sender.id === testWindow.webContents.id,
    );
    try {
      testWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(repositoryRoot, 'dist-electron', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await testWindow.loadURL('data:text/html,<html><body>runtime-test</body></html>');
      const preloadCapabilityResponse = await testWindow.webContents.executeJavaScript(`
        window.cardbushDesktop.runtime.command({
          protocol: 'bush.runtime_ipc.v1',
          type: 'command',
          operationId: 'operation_preload_capabilities',
          command: { kind: 'runtime.get_capabilities', payload: {} }
        })
      `);
      assert.equal(preloadCapabilityResponse.ok, true);
      assert.equal(
        preloadCapabilityResponse.result.eventProtocol,
        'bush.runtime_event.v1',
      );
    } finally {
      unregisterIpc();
      testWindow?.destroy();
    }
    controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const restartedController = new RuntimeUtilityProcessController({
      modulePath: path.join(
        repositoryRoot,
        'dist-electron',
        'runtimeHostWorker.mjs',
      ),
      env: {
        ...withoutProviderConfiguration(process.env),
        CARDBUSH_RUNTIME_STATE_ROOT: runtimeStateRoot,
      },
    });
    try {
      await within(restartedController.start(), 15_000, 'restarted Runtime Host');
      const recoveredSession = await restartedController.command({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: 'command',
        operationId: 'operation_recovered_session',
        command: {
          kind: GET_RUNTIME_SESSION_COMMAND,
          payload: { sessionId: 'session_durable' },
        },
      });
      assert.equal(recoveredSession.ok, true);
      assert.equal(recoveredSession.result.turns.length, 1);
      assert.equal(
        recoveredSession.result.turns[0].messages[0].message.content,
        'persist me',
      );
    } finally {
      restartedController.stop();
    }
    console.log('Electron Utility Runtime Host contract passed.');
  } finally {
    controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(runtimeStateRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    app.quit();
  }
}

function withoutProviderConfiguration(environment) {
  const sanitized = { ...environment };
  delete sanitized.CARDBUSH_RUNTIME_PROVIDER_API_KEY;
  delete sanitized.CARDBUSH_RUNTIME_PROVIDER_BASE_URL;
  return sanitized;
}

function within(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} did not complete in ${milliseconds} ms.`)),
        milliseconds,
      );
    }),
  ]);
}

async function collect(events) {
  const values = [];
  for await (const event of events) values.push(event);
  return values;
}
