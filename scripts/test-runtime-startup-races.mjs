import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the desktop's real initialization and IPC handlers with controlled
// service boundaries. No user profile, network, model, or sandbox is touched.
const source = ts.createSourceFile('main.ts', readFileSync('electron/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['ensureRuntimeServicesReady', 'ensureRuntimeHostReady', 'startRuntimeServices',
  'disposeRuntimeServices', 'initializeRuntimeHost', 'prepareRuntimeHost',
  'withRuntimeStartupTimeout', 'initializeProductHost', 'startRuntimeAutomations', 'runtimeStartupStep', 'contextWebhookHost'];
const functions = names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name); return declaration.getText(source);
});
const handlers = ['automation:command', 'cardbush-product-host:command', 'app:retry-runtime',
  'plugins:troubleshooting-context', 'plugins:save-connections', 'mcp:connection-action', 'webhooks:command'];
const registrations = handlers.map(channel => {
  const statement = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle' && node.expression.arguments[0]?.text === channel);
  assert.ok(statement, channel); return statement.getText(source);
});
const code = ts.transpileModule([...functions, ...registrations].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return ts.factory.updateCallExpression(node, ts.factory.createIdentifier('loadModule'), undefined, node.arguments);
    }
    return ts.visitEachChild(node, visit, context);
  })] },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(timeout = 2000) {
  const gates = {}, controllers = [], managers = [], browserEndpoints = [], products = [], calls = [], statuses = [], warnings = [], ipc = new Map();
  const wait = name => gates[name]?.promise ?? Promise.resolve();
  class Controller {
    disposed = false;
    constructor() { controllers.push(this); this.boot = wait('worker'); }
    async start() { await this.boot; if (this.disposed) throw Error('disposed'); }
    dispose() { this.disposed = true; }
    async command(message) { await this.start(); calls.push(message); return { ok: true, result: message.operationId }; }
  }
  class Product {
    constructor(options) { this.options = options; products.push(this); }
    async execute(input) { await wait('apps'); return input; }
    async refreshMcp(_uninstall, _update, signal) { this.refreshSignal = signal; this.refreshCount = (this.refreshCount ?? 0) + 1; await wait('refresh'); signal?.throwIfAborted(); }
    async pluginTroubleshootingContext() { return 'troubleshooting'; }
    async savePluginConnections() { return 'connections'; }
    async resolveWebhookModel(id, language) { this.resolutions ??= []; this.resolutions.push({ id, language }); return { model: 'current-model', binding: { bindingId: id, revision: 'current-revision' } }; }
  }
  const context = {
    Promise, Date, Error, AbortController, setTimeout, clearTimeout,
    console: { warn(...args) { warnings.push(args); }, error() {} }, path, pathToFileURL, __dirname: '/fixture',
    process: { env: {}, platform: 'win32', arch: 'x64', resourcesPath: '/resources' },
    app: { getPath: () => '/profile', getAppPath: () => '/app', commandLine: { getSwitchValue: () => '' } },
    browserConnectorDataRoot: () => '/connector-profile',
    cardbushRuntimeIsPackaged: false, packagedSmokeMode: false, assistantResident: false, residentBootTimer: undefined, runtimeServicesStartupTimeoutMs: timeout,
    runtimeServicesInitialization: null, runtimeServicesAbort: null, runtimeServicesStopping: false, isQuitting: false, runtimeAutomationStartup: null,
    contextWebhookHostPromise: undefined, webhookHosts: [],
    runtimeStartupStatus: { phase: 'initializing', attempt: 0 }, runtimeHostController: null,
    productHostController: null, sandboxSetup: undefined, productMcpManagement: null,
    runtimeHostIpc: { reset() {} }, disposeCapabilityCatalogWatcher: undefined,
    browserConnectorBroker: null, browserUseEndpoint: null, browserUseRouter: async () => ({}), shadowWindows: new Map(), bushRuntimeIpcProtocol: 'bush.runtime_ipc.v1',
    publishRuntimeStartupStatus(status) { context.runtimeStartupStatus = status; statuses.push(status); },
    dependentStarts: [], startupSteps: [],
    async embodiedHost() { context.dependentStarts.push(context.runtimeStartupStatus.phase); },
    appendDebugLog(_scope, entry) { context.startupSteps.push(entry); },
    registerDesktopControlMonitor() {}, disposeDesktopControlMonitor() {},
    resolveBundledRipgrepPath: () => undefined, productSkillRoots: () => [], productPluginRoots: () => [],
    visualThemeContextPath: () => '/theme', browserConfigurationPath: () => '/browser', productAppsConfigPath: () => '/apps',
    platformFeatures: () => ({}), productAppsConfig: () => ({}), appLogsDir: () => '/logs',
    bundledProductSkillRoot: () => '/skills', legacyBushserverModelConfigPaths: () => [],
    clearApplicationCaches() {}, watchCapabilityCatalog: () => () => {}, syncBrowserConnectorPlugin: async () => {},
    assertMainWindowSender() {}, assertRuntimeRendererSender() {},
    randomUUID: (() => { let id = 0; return () => `operation-${++id}`; })(),
    ipcMain: { handle: (channel, fn) => ipc.set(channel, fn) },
    async loadModule(url) {
      if (url.endsWith('contextWebhookRuntime.mjs')) return import('../dist-electron/contextWebhookRuntime.mjs');
      if (url.endsWith('contextWebhookHost.mjs')) return { ContextWebhookHost: class {
        constructor(_root, _secrets, runtime) { this.runtime = runtime; context.webhookHosts.push(this); }
        async start() { this.listening = true; return this; }
        async command(input) { return { listening: this.listening, sessionId: input.sessionId }; }
      } };
      if (url.endsWith('sandboxSetup.mjs')) return { SandboxSetup: class { get() { return wait('probe'); } } };
      if (url.endsWith('productMcpManagement.mjs')) return { async startProductMcpManagement() {
        const manager = { url: 'fixture', token: 'fixture', closed: 0, async close() { this.closed++; await wait('close'); } };
        managers.push(manager); await wait('management'); return manager;
      } };
      if (url.endsWith('runtimeHostController.mjs')) return { RuntimeUtilityProcessController: Controller };
      if (url.endsWith('browserUseHost.mjs')) return { async startBrowserUseHost() {
        const endpoint = { url: 'fixture-browser', token: 'fixture-browser', closed: 0, async close() { this.closed++; } };
        browserEndpoints.push(endpoint); await wait('browser'); return endpoint;
      } };
      if (url.endsWith('productHostController.mjs')) { await wait('product-import'); return { ElectronProductHostController: Product }; }
      throw Error(`Unexpected module ${url}`);
    },
  };
  vm.runInNewContext(code, context);
  const invoke = (channel, ...args) => ipc.get(channel)({ sender: { id: 1 } }, ...args);
  return { context, gates, controllers, managers, browserEndpoints, products, calls, statuses, warnings, invoke };
}

test('early desktop requests wait for one boot and each dispatches once', async () => {
  const f = fixture(); f.gates.probe = deferred();
  let settled = 0;
  const requests = [f.invoke('automation:command', { action: 'reminder' }),
    f.invoke('automation:command', { action: 'list' }),
    f.invoke('cardbush-product-host:command', { kind: 'model.list' }),
    f.invoke('plugins:troubleshooting-context', 'p', 'c'), f.invoke('plugins:save-connections', {}),
    f.invoke('mcp:connection-action', 'mcp', 'reconnect'),
    ...Array.from({ length: 20 }, () => f.context.ensureRuntimeHostReady())].map(p => p.then(value => { settled++; return value; }));
  await flush(); assert.equal(settled, 0); assert.equal(f.context.runtimeStartupStatus.attempt, 1);
  assert.equal(f.context.dependentStarts.length, 0, 'dependent services cannot compete with Runtime initialization');
  f.gates.probe.resolve(); await Promise.all(requests);
  assert.equal(f.controllers.length, 1); assert.equal(f.context.runtimeStartupStatus.phase, 'ready');
  assert.deepEqual(f.context.dependentStarts, ['ready']);
  assert.ok(f.context.startupSteps.some(entry => entry.step === 'worker-ready' && entry.stage === 'runtime-step-completed'));
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.automation').length, 2);
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.mcp_reconnect').length, 1);
  await f.context.startRuntimeServices(); assert.equal(f.controllers.length, 1);
});

test('failed boot retains the cause, background reads never retry, explicit retry is single-flight', async () => {
  const f = fixture(); f.gates.worker = deferred();
  const failed = assert.rejects(f.invoke('automation:command', { action: 'list' }), /fixture worker refused to start/);
  await flush(); f.gates.worker.reject(Error('fixture worker refused to start')); await failed;
  const old = f.controllers[0]; assert.equal(old.disposed, true);
  assert.equal(f.context.dependentStarts.length, 0, 'failed startup must not launch dependent services');
  await Promise.all(Array.from({ length: 30 }, () => assert.rejects(f.context.ensureRuntimeHostReady(), /fixture worker refused to start/)));
  assert.equal(f.controllers.length, 1); assert.equal(f.context.runtimeStartupStatus.attempt, 1);
  f.gates.worker = deferred(); f.gates.close = deferred();
  // Exercise the cleanup await on a retry as well as the worker await.
  f.context.productMcpManagement = { close: () => f.gates.close.promise };
  const retries = Array.from({ length: 10 }, () => f.invoke('app:retry-runtime'));
  await flush(); assert.equal(f.context.runtimeStartupStatus.attempt, 2);
  f.gates.close.resolve(); await flush();
  assert.equal(f.controllers.length, 2);
  f.gates.worker.resolve(); await Promise.all(retries);
  assert.equal(f.context.runtimeStartupStatus.phase, 'ready');
  assert.deepEqual(f.context.dependentStarts, ['ready'], 'explicit retry restores dependent services after readiness');
  await f.invoke('automation:command', { action: 'list' });
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.automation').length, 1, 'the failed request was not replayed');
});

test('cold preparation cannot consume worker or settings readiness budgets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(1000);
  for (const stage of ['probe', 'worker', 'apps']) f.gates[stage] = deferred();
  const outcome = f.context.ensureRuntimeHostReady().then(controller => ({ controller }), error => ({ error }));
  await flush();
  t.mock.timers.tick(700); f.gates.probe.resolve(); await flush();
  assert.equal(f.controllers.length, 1);
  t.mock.timers.tick(700); await flush();
  assert.equal(f.context.runtimeStartupStatus.phase, 'initializing', 'the worker still has its full readiness budget');
  assert.equal(f.controllers[0].disposed, false);
  f.gates.worker.resolve(); await flush();
  t.mock.timers.tick(700); await flush();
  assert.equal(f.context.runtimeStartupStatus.phase, 'initializing', 'settings readiness starts a separate bounded phase');
  assert.equal(f.context.dependentStarts.length, 0);
  f.gates.apps.resolve();
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(result.controller, f.controllers[0]);
  assert.equal(f.context.runtimeStartupStatus.phase, 'ready');
  assert.equal(f.context.runtimeStartupStatus.elapsedMs, 2100);
  assert.equal(f.context.runtimeStartupStatus.attempt, 1, 'slow preparation needs no retry');
  assert.deepEqual(f.context.dependentStarts, ['ready']);
});

for (const stage of ['probe', 'management', 'browser', 'product-import', 'worker', 'apps']) {
  test(`timeout during ${stage} cannot publish an old host after retry`, async () => {
    const f = fixture(30); const oldGate = deferred(); f.gates[stage] = oldGate;
    await assert.rejects(f.context.ensureRuntimeHostReady(), /did not become ready within 30ms/);
    assert.equal(f.context.runtimeStartupStatus.phase, 'error');
    const phase = stage === 'apps' ? 'settings' : ['worker', 'product-import'].includes(stage) ? 'services' : 'preparation';
    assert.ok(f.context.startupSteps.some(entry => entry.stage === 'runtime-phase-timeout' && entry.phase === phase));
    const oldControllers = [...f.controllers], oldManagers = [...f.managers], oldBrowserEndpoints = [...f.browserEndpoints];
    delete f.gates[stage]; f.context.runtimeServicesStartupTimeoutMs = 2000;
    await f.invoke('app:retry-runtime');
    const current = f.context.runtimeHostController, product = f.context.productHostController;
    const count = f.controllers.length;
    oldGate.resolve(); await flush(); await flush();
    assert.equal(f.controllers.length, count);
    assert.equal(f.context.runtimeHostController, current); assert.equal(f.context.productHostController, product);
    assert.equal(f.context.runtimeStartupStatus.phase, 'ready');
    assert.ok(oldControllers.every(item => item.disposed));
    assert.ok(oldManagers.every(item => item.closed === 1));
    assert.ok(oldBrowserEndpoints.every(item => item.closed === 1));
  });
}

test('shutdown blocks new initialization and late automation callbacks', async () => {
  const f = fixture(); f.gates.refresh = deferred();
  await f.context.ensureRuntimeHostReady();
  f.context.runtimeServicesStopping = true;
  await f.context.disposeRuntimeServices(); f.gates.refresh.resolve(); await flush();
  await assert.rejects(f.context.ensureRuntimeHostReady(), /shutting down/);
  await f.context.startRuntimeServices(true);
  assert.equal(f.controllers.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.products[0].refreshSignal.aborted, true);
  assert.equal(f.warnings.length, 0, 'expected cancellation must not appear as automation startup failure');
});

test('automation initialization starts only after all startup steps finish', async () => {
  const f = fixture(); f.gates.apps = deferred();
  const boot = f.context.startRuntimeServices(); await flush(); await flush();
  assert.equal(f.products.length, 1);
  assert.equal(f.products[0].refreshCount ?? 0, 0, 'catalog initialization must not compete with boot or its deadline');
  f.gates.apps.resolve(); await boot; await flush();
  assert.equal(f.products[0].refreshCount, 1);
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.automation_start').length, 1);
});

test('stopped or replaced automation initialization is cancelled without stale warnings', async () => {
  for (const mode of ['quit', 'retry']) {
    const f = fixture(); const oldRefresh = deferred(); f.gates.refresh = oldRefresh;
    await f.context.ensureRuntimeHostReady(); const old = f.products[0];
    if (mode === 'quit') { f.context.isQuitting = true; await f.context.disposeRuntimeServices(); }
    else { delete f.gates.refresh; await f.invoke('app:retry-runtime'); }
    oldRefresh.reject(Error('Runtime Utility Process was stopped.')); await flush(); await flush();
    assert.equal(old.refreshSignal.aborted, true);
    assert.equal(f.warnings.length, 0, 'a retired initialization must not report its cancellation as a new failure');
    assert.equal(f.calls.filter(item => item.command.kind === 'runtime.automation_start').length, mode === 'retry' ? 1 : 0);
  }
});

test('a current automation initialization failure remains visible', async () => {
  const f = fixture(); f.gates.refresh = deferred();
  await f.context.ensureRuntimeHostReady();
  f.gates.refresh.reject(Error('actual catalog failure')); await flush();
  assert.equal(f.warnings.length, 1); assert.match(f.warnings[0][1].message, /actual catalog failure/);
});

test('Webhook discovery starts independently before, during and after a failed Runtime boot', async () => {
  const f = fixture(); f.gates.worker = deferred();
  const first = await f.invoke('webhooks:command', { action: 'read', sessionId: 'existing' });
  assert.equal(first.listening, true); assert.equal(f.controllers.length, 0, 'reading services cannot launch Runtime');
  const boot = f.context.startRuntimeServices(); await flush();
  assert.equal((await f.invoke('webhooks:command', { action: 'read', sessionId: 'existing' })).listening, true);
  f.gates.worker.reject(Error('worker unavailable')); await boot;
  assert.equal(f.context.runtimeStartupStatus.phase, 'error');
  assert.equal((await f.invoke('webhooks:command', { action: 'read', sessionId: 'existing' })).listening, true);
  assert.equal(f.context.webhookHosts.length, 1, 'late Bot registration keeps using the original HTTP host');
  assert.equal(f.products[0].refreshCount ?? 0, 0, 'failed boot never starts automation initialization');
});

test('desktop Webhook model preparation waits for the active Product Host and preserves the message source', async () => {
  const f = fixture(); f.gates.worker = deferred();
  await f.invoke('webhooks:command', { action: 'read', sessionId: 'existing' });
  const parent = { model: 'old-model', providerBinding: { bindingId: 'chosen', revision: 'old-revision' },
    metadata: { uiLanguage: 'zh', botSourceRef: 'webhook:original' }, permissionMode: 'task_free' };
  const prepared = f.context.webhookHosts[0].runtime.prepareParent(parent, new AbortController().signal);
  await flush(); assert.equal(f.products[0]?.resolutions, undefined);
  f.gates.worker.resolve(); const result = await prepared;
  assert.equal(result.providerBinding.revision, 'current-revision');
  assert.equal(result.metadata.botSourceRef, 'webhook:original'); assert.equal(result.permissionMode, 'task_free');
  assert.equal(parent.providerBinding.revision, 'old-revision');
  assert.equal(f.products[0].resolutions[0].id, 'chosen'); assert.equal(f.products[0].resolutions[0].language, 'zh');
});

test('cleanup failure cannot hide the original startup failure', async () => {
  const f = fixture(); f.gates.worker = deferred();
  const failed = assert.rejects(f.context.ensureRuntimeHostReady(), /original worker failure/);
  await flush();
  f.managers[0].close = async () => { throw Error('secondary cleanup failure'); };
  f.gates.worker.reject(Error('original worker failure')); await failed;
  assert.equal(f.context.runtimeStartupStatus.error, 'original worker failure');
});
