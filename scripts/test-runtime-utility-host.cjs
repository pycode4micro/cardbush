const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { app, BrowserWindow, ipcMain } = require('electron');
// Closing the preload fixture must not end Electron before the restart and
// durable-history assertions below it have actually run.
app.on('window-all-closed', () => {});

void run().catch((error) => {
  console.error(error);
  app.exit(1);
});

async function run() {
  const {
    BUSH_MODEL_REQUEST_PROTOCOL,
    BUSH_MCP_SNAPSHOT_PROTOCOL,
    BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
    BUSH_RUNTIME_IPC_PROTOCOL,
    BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
    GET_RUNTIME_CAPABILITIES_COMMAND,
    GET_RUNTIME_SESSION_COMMAND,
    GET_RUNTIME_TOOL_CATALOG_COMMAND,
    REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
    RUN_MODEL_TURN_COMMAND,
    RUN_RUNTIME_SESSION_TURN_COMMAND,
    UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  } = await import('@cardbush/bush-protocol');
  const { ElectronRuntimeTransport } = await import(
    '@cardbush/bush-runtime-electron'
  );
  const repositoryRoot = path.resolve(__dirname, '..');
  const runtimeStateRoot = mkdtempSync(
    path.join(tmpdir(), 'cardbush-runtime-utility-'),
  );
  const appsConfigPath = path.join(runtimeStateRoot, 'product-host', 'config', 'apps.json');
  mkdirSync(path.dirname(appsConfigPath), { recursive: true });
  writeFileSync(appsConfigPath, JSON.stringify({
    protocol: 'cardbush.apps_config.v1',
    revision: 1,
    serviceEnabled: true,
    plugins: [{
      id: 'team', installed: false, enabled: false, config: {},
    }, {
      id: 'computer-use',
      installed: true,
      enabled: true,
      config: {
        screenshotDirectory: '',
        allowOpenApp: true,
        allowWindowClose: true,
      },
    }, {
      id: 'chrome',
      installed: true,
      enabled: true,
      config: {},
    }],
  }));

  const { installLocalProductPlugin } = require('../dist-electron/localPluginInstall.js');
  const userPluginRoot = path.join(runtimeStateRoot, 'plugins');
  await installLocalProductPlugin(path.join(repositoryRoot, 'release-plugins/team-0.2.0.zip'), userPluginRoot);
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
      CARDBUSH_RUNTIME_PLUGIN_DATA_ROOT: path.join(runtimeStateRoot, 'plugin-data'),
      CARDBUSH_APPS_CONFIG_PATH: appsConfigPath,
      CARDBUSH_RUNTIME_PLUGIN_ROOTS: JSON.stringify([{
        path: path.join(repositoryRoot, 'assets', 'plugins'),
        source: 'bundled',
      }, { path: userPluginRoot, source: 'user' }]),
      CARDBUSH_APPS_MCP_ENTRY: path.join(
        repositoryRoot,
        'packages',
        'cardbush-apps-mcp',
        'dist',
        'index.js',
      ),
      CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY: path.join(
        repositoryRoot,
        'packages',
        'cardbush-chrome-mcp',
        'dist',
        'index.js',
      ),
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
    assert.equal(capabilityResponse.result.features.includes('product_team_snapshot'), false);
    const originalPluginConfig = readFileSync(appsConfigPath, 'utf8');
    let teamOperation = 0;
    const teamCommand = (kind, payload = {}) => controller.command({ protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'command',
      operationId: `optional-team-${++teamOperation}`, command: { kind, payload } });
    try {
      const withTeam = JSON.parse(originalPluginConfig);
      const configuredTeam = withTeam.plugins.find(plugin => plugin.id === 'team');
      configuredTeam.installed = true; configuredTeam.enabled = true;
      writeFileSync(appsConfigPath, JSON.stringify(withTeam));
      const enabled = await teamCommand(GET_RUNTIME_CAPABILITIES_COMMAND);
      assert.equal(enabled.ok, true);
      assert.equal(enabled.result.features.includes('product_team_snapshot'), true);
      const configuration = await teamCommand('plugin.team.configuration', { action: 'read' });
      assert.equal(configuration.ok, true);
      assert.equal(configuration.result.path, path.join(runtimeStateRoot, 'plugin-data', 'team', 'teams.json'));
      assert.ok((await teamCommand(GET_RUNTIME_TOOL_CATALOG_COMMAND)).result.some(tool => tool.name === 'team_delegate'));
      configuredTeam.enabled = false;
      writeFileSync(appsConfigPath, JSON.stringify(withTeam));
      assert.equal((await teamCommand(GET_RUNTIME_TOOL_CATALOG_COMMAND)).result.some(tool => tool.name === 'team_delegate'), false);
      assert.equal((await teamCommand('runtime.get_team_snapshot')).ok, false);
      writeFileSync(appsConfigPath, '{ malformed plugin config');
      const unavailable = await teamCommand(GET_RUNTIME_CAPABILITIES_COMMAND);
      assert.equal(unavailable.ok, true, 'optional plugin failure does not block core capability reads');
      assert.equal(unavailable.result.features.includes('product_team_snapshot'), false);
    } finally { writeFileSync(appsConfigPath, originalPluginConfig); }
    let mcpObservation = 0;
    const waitForMcp = () => within((async () => {
      while (true) {
        const response = await controller.command({ protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'command', operationId: `mcp-observation-${++mcpObservation}`,
          command: { kind: 'runtime.get_mcp_snapshot', payload: {} } });
        assert.equal(response.ok, true);
        assert.notEqual(response.result?.applicationState, 'failed', response.result?.applicationError);
        if (response.result?.applicationState === 'applied') return response.result;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })(), 30_000, 'background MCP publication');
    const mcpResponse = await within(
      controller.command({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: 'command',
        operationId: 'operation_apply_bundled_mcp',
        command: {
          kind: APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
          payload: {
            protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
            snapshotId: 'utility-bundled-plugins',
            revision: 1,
            servers: [],
          },
        },
      }),
      30_000,
      'bundled MCP plugin startup',
    );
    assert.equal(mcpResponse.ok, true);
    mcpResponse.result = await waitForMcp();
    assert.deepEqual(
      mcpResponse.result.servers.map((server) => server.id),
      ['cardbush_apps', 'chrome_devtools'],
    );
    const toolCatalogResponse = await controller.command({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'command',
      operationId: 'operation_bundled_tool_catalog',
      command: { kind: GET_RUNTIME_TOOL_CATALOG_COMMAND, payload: {} },
    });
    assert.equal(toolCatalogResponse.ok, true);
    const toolNames = toolCatalogResponse.result.map((tool) => tool.name);
    assert.ok(toolNames.includes('search_skills'));
    assert.ok(toolNames.includes('mcp__cardbush_apps__computer_use'));
    assert.ok(toolNames.includes('mcp__chrome_devtools__navigate_page'));
    const originalApps = JSON.parse(readFileSync(appsConfigPath, 'utf8'));
    const changedApps = structuredClone(originalApps);
    changedApps.plugins.find(plugin => plugin.id === 'chrome').enabled = false;
    // External edits need not know the host's revision bookkeeping.
    writeFileSync(appsConfigPath, JSON.stringify(changedApps));
    const hotApply = async operationId => {
      const response = await controller.command({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'command', operationId,
        command: { kind: APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND, payload: {
          protocol: BUSH_MCP_SNAPSHOT_PROTOCOL, snapshotId: 'utility-bundled-plugins', revision: 1, servers: [],
        } },
      });
      assert.equal(response.ok, true);
      return { ...response, result: await waitForMcp() };
    };
    const disabledChrome = await hotApply('hot_disable_chrome');
    assert.equal(disabledChrome.ok, true);
    assert.deepEqual(disabledChrome.result.servers.map(server => server.id), ['cardbush_apps']);
    assert.ok(disabledChrome.result.revision > mcpResponse.result.revision);
    writeFileSync(appsConfigPath, JSON.stringify(originalApps));
    const restoredChrome = await hotApply('hot_restore_chrome');
    assert.equal(restoredChrome.ok, true);
    assert.deepEqual(restoredChrome.result.servers.map(server => server.id), ['cardbush_apps', 'chrome_devtools']);
    assert.ok(restoredChrome.result.revision > disabledChrome.result.revision);
    const noop = await hotApply('hot_noop');
    assert.equal(noop.result.revision, restoredChrome.result.revision);
    console.log('Utility hot refresh passed: external config edits, disable/enable and stable no-op revision on the same Runtime process.');
    const configuredProvider = await controller.command({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'command',
      operationId: 'operation_configure_provider',
      command: {
        kind: UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
        payload: {
          protocol: BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
          bindingId: 'utility_provider',
          adapter: 'openai_responses',
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
    assert.equal(turnResponse.type, 'command_response');
    assert.equal(turnResponse.ok, true);
    await within(streamComplete, 15_000, 'Runtime Turn stream').catch((error) => {
      error.message += `; observed frames: ${JSON.stringify(frames)}`;
      throw error;
    });
    removeFrameListener();

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
      const releasedSubscriptions = [];
      const originalStopStream = controller.stopStream.bind(controller);
      controller.stopStream = async (message) => {
        releasedSubscriptions.push(message.subscriptionId);
        return originalStopStream(message);
      };
      // Subscribe to a quiet, not-yet-started Turn: cleanup must work without
      // waiting for another stream frame to reveal that the renderer is gone.
      await testWindow.webContents.executeJavaScript(`
        window.cardbushDesktop.runtime.startStream({protocol:'bush.runtime_ipc.v1',
          type:'start_stream',subscriptionId:'reload-old',
          request:{sessionId:'quiet-reload-session',turnId:'quiet-turn'}})
      `);
      await testWindow.loadURL('data:text/html,<html><body>runtime-after-reload</body></html>');
      await new Promise(resolve=>setTimeout(resolve,50));
      assert.ok(releasedSubscriptions.includes('reload-old'), 'real navigation releases a quiet old subscription');
      await testWindow.webContents.executeJavaScript(`
        window.cardbushDesktop.runtime.startStream({protocol:'bush.runtime_ipc.v1',
          type:'start_stream',subscriptionId:'reload-new',
          request:{sessionId:'quiet-reload-session',turnId:'quiet-turn'}})
      `);
      assert.equal(releasedSubscriptions.includes('reload-new'),false,'the new document stays subscribed');
      testWindow.destroy();
      await new Promise(resolve=>setTimeout(resolve,50));
      assert.ok(releasedSubscriptions.includes('reload-new'),'destroy releases the final quiet subscription');
      controller.stopStream = originalStopStream;
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
      CARDBUSH_RUNTIME_PLUGIN_DATA_ROOT: path.join(runtimeStateRoot, 'plugin-data'),
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
