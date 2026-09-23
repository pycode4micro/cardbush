import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SandboxSetup, sandboxInstaller } from '../dist-electron/sandboxSetup.mjs';
import { loadCommandSandboxConfiguration } from '../packages/bush-runtime/dist/index.js';
import { ProductHost } from '../packages/cardbush-product-host/dist/index.js';

async function fixture(t, override = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-setup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { probe: { state: 'missing', installed: false }, installs: 0 };
  const options = { path: join(directory, 'sandbox.json'), env: { CARDBUSH_EXECUTION_SANDBOX: undefined }, platform: 'linux',
    probe: async () => ({ ...state.probe }), installer: async () => ({ name: 'fixture', executable: '/usr/bin/fixture', args: ['install', 'bubblewrap'] }),
    install: async () => { state.installs++; state.probe = { state: 'ready', installed: true }; }, ...override };
  return { options, state, setup: new SandboxSetup(options) };
}

test('installer detection recognizes package-manager capabilities without requiring distribution metadata', async () => {
  const detect = (available, trusted = true) => sandboxInstaller({ PATH: '/usr/bin:.:relative:/usr/sbin' }, {
    find: (name, context) => {
      assert.equal(context.env.PATH, '/usr/bin:/usr/sbin');
      return available.includes(name) ? `/usr/bin/${name}` : undefined;
    },
    validate: async path => { if (!trusted) throw Error('Untrusted installer'); return path; },
  });
  for (const [manager, args] of [
    ['apt-get', ['install', '-y', 'bubblewrap']], ['dnf', ['install', '-y', 'bubblewrap']],
    ['dnf5', ['install', '-y', 'bubblewrap']], ['yum', ['install', '-y', 'bubblewrap']],
    ['pacman', ['-S', '--needed', '--noconfirm', 'bubblewrap']],
    ['zypper', ['--non-interactive', 'install', 'bubblewrap']], ['apk', ['add', 'bubblewrap']],
  ]) {
    const plan = await detect([manager]);
    assert.equal(plan.name, manager);
    assert.equal(plan.executable, `/usr/bin/${manager}`);
    assert.deepEqual(plan.args, args);
  }
  assert.equal((await detect(['dnf', 'dnf5', 'yum'])).name, 'dnf');
  assert.equal((await detect(['dnf5', 'yum'])).name, 'dnf5');
  assert.equal(await detect(['unknown-manager']), undefined);
  assert.equal(await detect([]), undefined);
  assert.equal(await detect(['apt-get'], false), undefined, 'an untrusted executable disables installation instead of crashing detection');
});

test('untrusted or vanished installers cannot become executable plans, and discovery can still recover', async () => {
  const examined = [];
  const plan = await sandboxInstaller({ PATH: '/home/user/bin:.:relative:/usr/bin', NODE_OPTIONS: '--require injected.js' }, {
    find: (name, context) => {
      assert.equal(context.env.PATH, '/home/user/bin:/usr/bin');
      assert.equal(context.env.NODE_OPTIONS, undefined);
      return { 'apt-get': '/home/user/bin/apt-get', dnf: '/usr/bin/dnf', dnf5: '/usr/bin/dnf5' }[name];
    },
    validate: async path => {
      examined.push(path);
      if (path.includes('/home/')) throw Error('Untrusted installer');
      if (path.endsWith('/dnf')) throw Object.assign(Error('Installer disappeared'), { code: 'ENOENT' });
      return '/usr/libexec/dnf5';
    },
  });
  assert.deepEqual(examined, ['/home/user/bin/apt-get', '/usr/bin/dnf', '/usr/bin/dnf5']);
  assert.equal(plan.name, 'dnf5');
  assert.equal(plan.executable, '/usr/libexec/dnf5', 'only the validated canonical executable may run');
  assert.deepEqual(plan.args, ['install', '-y', 'bubblewrap']);
});

test('undetected installation support disables setup and cannot be bypassed through the host API', async t => {
  const f = await fixture(t, { installer: async () => undefined });
  const status = await f.setup.get();
  assert.equal(status.canInstall, false);
  assert.equal(status.manualCommand, undefined);
  const host = new ProductHost(undefined, undefined, undefined, undefined, undefined, f.setup);
  const result = await host.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'sandbox.install', confirm: true });
  assert.equal(result.ok, false); assert.match(result.error.message, /No supported sandbox installer/);
  assert.equal(f.state.installs, 0);
  await assert.rejects(stat(f.options.path), { code: 'ENOENT' });
});

test('detection never installs; explicit install enables automatically and persists across host restart', async t => {
  const { setup, options, state } = await fixture(t);
  assert.equal((await setup.get()).enabled, false);
  assert.equal(state.installs, 0);
  await assert.rejects(stat(options.path), { code: 'ENOENT' });
  const [one, two] = await Promise.all([setup.install(), setup.install()]);
  assert.equal(state.installs, 1, 'concurrent clicks cannot install twice');
  assert.equal(one.enabled, true); assert.equal(two.enabled, true);
  assert.equal((await new SandboxSetup(options).get()).enabled, true);
  assert.equal((await loadCommandSandboxConfiguration(options.env, options.path)).mode, 'auto');
  await setup.update(false);
  assert.equal((await new SandboxSetup(options).get()).enabled, false, 'startup never erases opt-out');
  assert.equal((await loadCommandSandboxConfiguration(options.env, options.path)).mode, 'off');
});

test('a burst of install, check and toggle requests is serialized and the final user choice survives restart', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let active = 0, maxActive = 0;
  const f = await fixture(t, { install: async () => {
    f.state.installs++; active++; maxActive = Math.max(maxActive, active);
    started.resolve(); await release.promise;
    f.state.probe = { state: 'ready', installed: true }; active--;
  } });
  const first = f.setup.install(); await started.promise;
  const pending = [first];
  for (let i = 0; i < 40; i++) pending.push(f.setup.install(), f.setup.get(), f.setup.update(i % 2 === 0));
  pending.push(f.setup.update(false));
  assert.equal(f.state.installs, 1, 'queued requests cannot start another installer while one is running');
  release.resolve();
  const results = await Promise.all(pending);
  assert.equal(results.length, 122); assert.equal(maxActive, 1); assert.equal(f.state.installs, 1);
  assert.equal(results.at(-1).enabled, false);
  assert.equal((await new SandboxSetup(f.options).get()).enabled, false);
  assert.deepEqual(JSON.parse(await readFile(f.options.path, 'utf8')), { version: 1, enabled: false });
  assert.deepEqual(await readdir(join(f.options.path, '..')), ['sandbox.json'], 'no temporary settings files leak');
});

test('a failed install does not poison queued status requests or an explicit retry', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, { install: async () => {
    f.state.installs++;
    if (f.state.installs === 1) { started.resolve(); await release.promise; throw Error('package manager interrupted'); }
    f.state.probe = { state: 'ready', installed: true };
  } });
  const failure = assert.rejects(f.setup.install(), /interrupted/); await started.promise;
  const check = f.setup.get(), retry = f.setup.install(); release.resolve();
  await failure;
  assert.equal((await check).enabled, false);
  assert.equal((await retry).enabled, true); assert.equal(f.state.installs, 2);
});

test('an unreadable settings target cannot report success or block later requests', async t => {
  const f = await fixture(t);
  f.state.probe = { state: 'ready', installed: true };
  await writeFile(f.options.path, JSON.stringify({ version: 1, enabled: false }));
  await rm(f.options.path); await mkdir(f.options.path);
  await assert.rejects(f.setup.update(true), /saved sandbox setting/);
  await rmdir(f.options.path);
  await writeFile(f.options.path, JSON.stringify({ version: 1, enabled: false }));
  assert.equal((await f.setup.get()).enabled, false);
  assert.equal((await f.setup.update(true)).enabled, true);
});

test('bundled/externally installed components enable by default; a later backend failure never silently disables protection', async t => {
  const { setup, options, state } = await fixture(t);
  state.probe = { state: 'ready', installed: true };
  assert.equal((await setup.get()).enabled, true);
  state.probe = { state: 'blocked', installed: true, detail: 'namespace denied' };
  const status = await new SandboxSetup(options).get();
  assert.equal(status.state, 'blocked'); assert.equal(status.enabled, true);
  assert.equal((await loadCommandSandboxConfiguration(options.env, options.path)).mode, 'auto');
  assert.equal(state.installs, 0);
});

test('failed package installation or capability verification cannot enable the sandbox', async t => {
  const f = await fixture(t, { install: async () => { throw Error('no administrator authorization'); } });
  await assert.rejects(f.setup.install(), /administrator/);
  assert.equal((await f.setup.get()).enabled, false);
  const blocked = new SandboxSetup({ ...f.options, install: async () => { f.state.probe = { state: 'blocked', installed: true, detail: 'LSM denied' }; } });
  await assert.rejects(blocked.install(), /LSM denied/);
  assert.equal((await blocked.get()).enabled, false);
  await assert.rejects(stat(f.options.path), { code: 'ENOENT' });
});

test('administrator policies and corrupt saved settings cannot be overridden through settings', async t => {
  const f = await fixture(t);
  f.state.probe = { state: 'ready', installed: true };
  for (const mode of ['off', 'required']) {
    const env = { CARDBUSH_EXECUTION_SANDBOX: ` ${mode} ` };
    const setup = new SandboxSetup({ ...f.options, env });
    assert.equal((await setup.get()).managed, true);
    await assert.rejects(setup.install(), /administrator/);
    await assert.rejects(setup.update(true), /administrator/);
    await writeFile(f.options.path, JSON.stringify({ version: 1, enabled: mode === 'off' }));
    assert.equal((await loadCommandSandboxConfiguration(env, f.options.path)).mode, mode);
  }
  await writeFile(f.options.path, '{bad');
  await assert.rejects(f.setup.get(), /saved sandbox setting/);
  await assert.rejects(loadCommandSandboxConfiguration({}, f.options.path), /saved sandbox setting/);
  assert.equal(await readFile(f.options.path, 'utf8'), '{bad', 'a failed check cannot rewrite saved policy');
});

test('invalid saved policy variants and interrupted temporary writes never silently disable protection', async t => {
  const f = await fixture(t);
  f.state.probe = { state: 'ready', installed: true };
  for (const value of ['null', '[]', '{}', '{"version":2,"enabled":true}', '{"version":1,"enabled":"false"}', '{"version":1,"enabled":0}']) {
    await writeFile(f.options.path, value);
    await assert.rejects(f.setup.get(), /saved sandbox setting/);
    await assert.rejects(f.setup.update(false), /saved sandbox setting/);
    assert.equal(await readFile(f.options.path, 'utf8'), value);
  }
  await writeFile(f.options.path, JSON.stringify({ version: 1, enabled: true }));
  await writeFile(`${f.options.path}.interrupted.tmp`, '{"version":1,"enabled":');
  assert.equal((await new SandboxSetup(f.options).get()).enabled, true);
  assert.equal((await loadCommandSandboxConfiguration({}, f.options.path)).mode, 'auto');
});

test('product API requires explicit installation and rejects arbitrary commands and paths', async t => {
  const f = await fixture(t);
  const host = new ProductHost(undefined, undefined, undefined, undefined, undefined, f.setup);
  const run = command => host.execute({ protocol: 'cardbush.product_host_ipc.v1', ...command });
  assert.equal((await run({ kind: 'sandbox.get' })).ok, true);
  for (const input of [{ kind: 'sandbox.install' }, { kind: 'sandbox.install', confirm: true, executable: '/tmp/evil' },
    { kind: 'sandbox.update', enabled: 'true' }, { kind: 'sandbox.update', enabled: true, path: '/etc' }]) assert.equal((await run(input)).ok, false);
  assert.equal(f.state.installs, 0);
  assert.equal((await run({ kind: 'sandbox.install', confirm: true })).ok, true);
  assert.equal(f.state.installs, 1);
});

test('actual host detects its sandbox without installing packages and retains enabled state', { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-setup-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const setup = new SandboxSetup({ path: join(directory, 'sandbox.json'), env: { CARDBUSH_EXECUTION_SANDBOX: undefined } });
  const status = await setup.get();
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.enabled, true); assert.equal(status.canInstall, false);
  assert.equal((await setup.update(false)).enabled, false);
  assert.equal((await setup.get()).enabled, false);
});
