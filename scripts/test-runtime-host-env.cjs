const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const electron = require('electron');

const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'cardbush-runtime-env-'));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('CARDBUSH_') && name !== 'ELECTRON_RUN_AS_NODE'));
  const child = require('node:child_process').spawnSync(electron, [__filename, root], {
    cwd: resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true, timeout: 60_000,
  });
  assert.equal(dirname(root), parent);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}

const { app } = electron;
const root = resolve(process.argv[2]);
assert.equal(dirname(root), parent);
assert.ok(require('node:path').basename(root).startsWith('cardbush-runtime-env-'));
mkdirSync(join(root, 'profile'));
app.setPath('userData', join(root, 'profile'));
const deadline = setTimeout(() => { console.error('Runtime environment test timed out.'); app.exit(1); }, 55_000);
void run().then(() => { clearTimeout(deadline); app.exit(0); }, error => { console.error(error); app.exit(1); });

async function run() {
  await app.whenReady();
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { ElectronProductHostController } = await import('../dist-electron/productHostController.mjs');
  const { SandboxSetup } = await import('../dist-electron/sandboxSetup.mjs');
  const inherited = { ...process.env };
  const fixture = join(root, 'environment.cjs');
  writeFileSync(fixture, `
    const protocol = 'bush.runtime_ipc.v1';
    process.parentPort.on('message', ({ data }) => {
      process.parentPort.postMessage({ protocol, type: 'command_response', operationId: data.operationId, ok: true, result: {
        sandbox: process.env.CARDBUSH_EXECUTION_SANDBOX ?? null,
        futurePresent: Object.hasOwn(process.env, 'CARDBUSH_FUTURE_OPTIONAL'),
        empty: process.env.CARDBUSH_ENV_TEST_EMPTY ?? null,
        unicode: process.env.CARDBUSH_ENV_TEST_UNICODE,
        coordination: process.env.CARDBUSH_RESOURCE_COORDINATION,
      } });
    });
    process.parentPort.postMessage({ protocol, type: 'ready', capabilities: {
      protocol: 'bush.runtime_capabilities.v1', hostId: 'env-fixture', runtimeVersion: 'test',
      eventProtocol: 'bush.runtime_event.v1', supportedEvents: [], supportedCommands: [], features: [],
    } });
  `);
  let sequence = 0;
  const command = async (controller, kind, payload = {}) => {
    const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command',
      operationId: `env-test-${++sequence}`, command: { kind, payload } });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  for (const mode of [undefined, '', 'auto', 'off', 'required']) {
    const env = { ...inherited, CARDBUSH_EXECUTION_SANDBOX: mode, CARDBUSH_FUTURE_OPTIONAL: undefined,
      CARDBUSH_ENV_TEST_EMPTY: '', CARDBUSH_ENV_TEST_UNICODE: '中文 = sandbox', CARDBUSH_RESOURCE_COORDINATION: undefined };
    const controller = new RuntimeUtilityProcessController({ modulePath: fixture, env });
    try {
      await controller.start();
      // Windows exposes empty environment values as absent in the child. The
      // lifecycle test checks that the original empty string reaches fork.
      const empty = process.platform === 'win32' ? null : '';
      const expected = { sandbox: mode === '' ? empty : mode ?? null, futurePresent: false,
        empty, unicode: '中文 = sandbox', coordination: 'desktop' };
      assert.deepEqual(await command(controller, 'probe'), expected);
      assert.equal(env.CARDBUSH_RESOURCE_COORDINATION, undefined, 'startup must not mutate the host environment');
      if (mode === undefined) {
        controller.stop();
        await controller.start();
        assert.deepEqual(await command(controller, 'probe'), expected, 'restart applies the same environment normalization');
      }
    } finally { controller.stop(); }
  }
  console.log('Real Electron: unset/future optional variables, empty/Unicode values, sandbox policy overrides and restart passed.');

  const stateRoot = join(root, 'runtime');
  const settings = join(root, 'product', 'config', 'sandbox.json');
  const env = { ...inherited, CARDBUSH_EXECUTION_SANDBOX: undefined, CARDBUSH_FUTURE_OPTIONAL: undefined,
    CARDBUSH_SANDBOX_SETTINGS_PATH: settings, CARDBUSH_RUNTIME_STATE_ROOT: stateRoot,
    CARDBUSH_USAGE_LEDGER_PATH: join(root, 'usage.sqlite'),
    CARDBUSH_PROCESS_HOST_DIRECTORY: resolve('dist-native/process-guard'),
    CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]',
  };
  const sandbox = new SandboxSetup({ path: settings, env, windowsHostDirectory: env.CARDBUSH_PROCESS_HOST_DIRECTORY });
  const detected = await sandbox.get();
  if (process.platform === 'win32') {
    assert.equal(detected.state, 'ready', detected.detail);
    assert.equal(detected.enabled, true, 'an installed sandbox is still enabled by default without a CLI override');
    assert.equal(detected.managed, false, 'an omitted policy must not become an administrative off override');
  }
  const controller = new RuntimeUtilityProcessController({ modulePath: resolve('dist-electron/runtimeHostWorker.mjs'), env,
    onStderr: text => process.stderr.write(text),
  });
  const host = new ElectronProductHostController({ dataRoot: join(root, 'product'), runtimeStateRoot: stateRoot,
    bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'),
    bundledPluginRoot: join(root, 'plugins'), userPluginRoot: join(root, 'user-plugins'), runtimeBridge: controller, sandbox,
  });
  const product = async (kind, payload = {}) => {
    const response = await host.execute({ protocol: 'cardbush.product_host_ipc.v1', kind, ...payload });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.value;
  };
  try {
    const [ready, capabilities] = await Promise.all([controller.start(), command(controller, 'runtime.get_capabilities')]);
    assert.deepEqual(ready.capabilities, capabilities);
    const status = await product('sandbox.get');
    assert.deepEqual(status, detected, 'settings can query the sandbox after the real desktop worker starts');
    await product('sandbox.update', { enabled: false });
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).enabled, false);
    controller.stop();
    const restarted = await controller.start();
    assert.notEqual(restarted.capabilities.hostId, capabilities.hostId, 'restart creates a fresh Runtime process');
    assert.deepEqual(await command(controller, 'runtime.get_capabilities'), restarted.capabilities);
    assert.equal((await product('sandbox.get')).enabled, false,
      'restart preserves a saved sandbox opt-out without forcing an environment override');
    console.log('Real desktop Runtime: concurrent startup/capability request, native sandbox detection, settings API and persisted opt-out after restart passed.');
  } finally {
    await host.shutdown().finally(() => controller.stop());
  }
}
