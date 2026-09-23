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
  'disposeRuntimeServices', 'initializeRuntimeHost', 'initializeRuntimeHostWithinDeadline',
  'withRuntimeStartupTimeout', 'initializeProductHost', 'startRuntimeAutomations'];
const functions = names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name); return declaration.getText(source);
});
const handlers = ['automation:command', 'cardbush-product-host:command', 'app:retry-runtime',
  'plugins:troubleshooting-context', 'plugins:save-connections', 'mcp:connection-action'];
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
  const gates = {}, controllers = [], managers = [], products = [], calls = [], statuses = [], ipc = new Map();
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
    async refreshMcp() { await wait('refresh'); }
    async pluginTroubleshootingContext() { return 'troubleshooting'; }
    async savePluginConnections() { return 'connections'; }
  }
  const context = {
    Promise, Date, Error, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, error() {} }, path, pathToFileURL, __dirname: '/fixture',
    process: { env: {}, platform: 'win32', arch: 'x64', resourcesPath: '/resources' },
    app: { getPath: () => '/profile', getAppPath: () => '/app', commandLine: { getSwitchValue: () => '' } },
    cardbushRuntimeIsPackaged: false, runtimeServicesStartupTimeoutMs: timeout,
    runtimeServicesInitialization: null, runtimeServicesAbort: null, runtimeServicesStopping: false,
    runtimeStartupStatus: { phase: 'initializing', attempt: 0 }, runtimeHostController: null,
    productHostController: null, sandboxSetup: undefined, productMcpManagement: null,
    runtimeHostIpc: { reset() {} }, disposeCapabilityCatalogWatcher: undefined,
    chromeConnectorBroker: null, shadowWindows: new Map(), bushRuntimeIpcProtocol: 'bush.runtime_ipc.v1',
    publishRuntimeStartupStatus(status) { context.runtimeStartupStatus = status; statuses.push(status); },
    registerDesktopControlMonitor() {}, disposeDesktopControlMonitor() {},
    resolveBundledRipgrepPath: () => undefined, productSkillRoots: () => [], productPluginRoots: () => [],
    visualThemeContextPath: () => '/theme', browserConfigurationPath: () => '/browser', productAppsConfigPath: () => '/apps',
    platformFeatures: () => ({}), productAppsConfig: () => ({}), appLogsDir: () => '/logs',
    bundledProductSkillRoot: () => '/skills', legacyBushserverModelConfigPaths: () => [],
    clearApplicationCaches() {}, watchCapabilityCatalog: () => () => {},
    assertMainWindowSender() {}, assertRuntimeRendererSender() {},
    randomUUID: (() => { let id = 0; return () => `operation-${++id}`; })(),
    ipcMain: { handle: (channel, fn) => ipc.set(channel, fn) },
    async loadModule(url) {
      if (url.endsWith('sandboxSetup.mjs')) return { SandboxSetup: class { get() { return wait('probe'); } } };
      if (url.endsWith('productMcpManagement.mjs')) return { async startProductMcpManagement() {
        const manager = { url: 'fixture', token: 'fixture', closed: 0, async close() { this.closed++; await wait('close'); } };
        managers.push(manager); await wait('management'); return manager;
      } };
      if (url.endsWith('runtimeHostController.mjs')) return { RuntimeUtilityProcessController: Controller };
      if (url.endsWith('productHostController.mjs')) { await wait('product-import'); return { ElectronProductHostController: Product }; }
      throw Error(`Unexpected module ${url}`);
    },
  };
  vm.runInNewContext(code, context);
  const invoke = (channel, ...args) => ipc.get(channel)({ sender: { id: 1 } }, ...args);
  return { context, gates, controllers, managers, products, calls, statuses, invoke };
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
  f.gates.probe.resolve(); await Promise.all(requests);
  assert.equal(f.controllers.length, 1); assert.equal(f.context.runtimeStartupStatus.phase, 'ready');
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.automation').length, 2);
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.mcp_reconnect').length, 1);
  await f.context.startRuntimeServices(); assert.equal(f.controllers.length, 1);
});

test('failed boot retains the cause, background reads never retry, explicit retry is single-flight', async () => {
  const f = fixture(); f.gates.worker = deferred();
  const failed = assert.rejects(f.invoke('automation:command', { action: 'list' }), /fixture worker refused to start/);
  await flush(); f.gates.worker.reject(Error('fixture worker refused to start')); await failed;
  const old = f.controllers[0]; assert.equal(old.disposed, true);
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
  await f.invoke('automation:command', { action: 'list' });
  assert.equal(f.calls.filter(item => item.command.kind === 'runtime.automation').length, 1, 'the failed request was not replayed');
});

for (const stage of ['probe', 'management', 'product-import']) {
  test(`timeout during ${stage} cannot publish an old host after retry`, async () => {
    const f = fixture(30); const oldGate = deferred(); f.gates[stage] = oldGate;
    await assert.rejects(f.context.ensureRuntimeHostReady(), /did not become ready within 30ms/);
    assert.equal(f.context.runtimeStartupStatus.phase, 'error');
    const oldControllers = [...f.controllers], oldManagers = [...f.managers];
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
});

test('cleanup failure cannot hide the original startup failure', async () => {
  const f = fixture(); f.gates.worker = deferred();
  const failed = assert.rejects(f.context.ensureRuntimeHostReady(), /original worker failure/);
  await flush();
  f.managers[0].close = async () => { throw Error('secondary cleanup failure'); };
  f.gates.worker.reject(Error('original worker failure')); await failed;
  assert.equal(f.context.runtimeStartupStatus.error, 'original worker failure');
});
