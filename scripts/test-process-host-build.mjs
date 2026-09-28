import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProcessResourceHost, unavailableProcessHostBuild } from './lib/process-host-build.mjs';
import { guiBuildState } from './run-electron-gui.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-host-build-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, content = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const compiler = write('Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  write('native/process-guard/CardBushProcessHost.cs', 'host source');
  write('native/process-guard/ProcessSandbox.cs', 'sandbox source');
  write('scripts/build-process-resource-host.mjs', 'builder');
  write('scripts/lib/process-host-build.mjs', 'build implementation');
  write('package.json', JSON.stringify({ scripts: { 'build:runtime': 'npm run build --workspace active-plugin' } }));
  write('src/main.ts', 'renderer');
  for (const name of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.js']) {
    const file = write(name, 'built output');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);
  }
  const nativeDirectory = path.join(root, 'dist-native/process-guard');
  const manifest = path.join(nativeDirectory, 'current.json');
  const receipt = path.join(nativeDirectory, 'development-unavailable.json');
  const state = { probes: 0, compiles: 0, warnings: [], compileError: false, probe: {
    status: null, error: Object.assign(new Error('spawnSync process-host.exe UNKNOWN'), { code: 'UNKNOWN' }),
  } };
  const options = {
    root, platform: 'win32', env: { WINDIR: path.join(root, 'Windows') },
    warn: text => state.warnings.push(text), log: () => {},
    run: (executable, args) => {
      if (executable === compiler) {
        state.compiles++;
        if (state.compileError) return { status: 1, stderr: 'C# compilation failed' };
        fs.writeFileSync(args.find(arg => arg.startsWith('/out:')).slice(5), 'complete executable');
        return { status: 0 };
      }
      assert.deepEqual(args, ['--capabilities'], 'the build never retries a user command without protection');
      state.probes++;
      return state.probe;
    },
  };
  const build = (allowUnavailable = false) => buildProcessResourceHost({ ...options, allowUnavailable });
  const ready = () => { state.probe = { status: 0, stdout: JSON.stringify({ protocol: 'cardbush.process-host.v1', sandboxVersion: 1 }) }; };
  return { root, write, manifest, receipt, state, options, build, ready, compiler };
}

test('development startup can build the GUI while an unlaunchable host stays unpublished', t => {
  const f = fixture(t);
  assert.equal(guiBuildState(f.root, 'win32').current, false);
  assert.deepEqual(f.build(true), { available: false });
  assert.equal(fs.existsSync(f.manifest), false);
  assert.equal(guiBuildState(f.root, 'win32').current, true, 'no endless rebuild when there is no usable host');
  assert.match(f.state.warnings[0], /UNKNOWN/);
  assert.match(f.state.warnings[0], /CodeIntegrity\/Operational/);
  assert.match(f.state.warnings[0], /Protected commands remain unavailable/);
  assert.equal(unavailableProcessHostBuild(f.root).version, 1);
  assert.equal(f.state.probes, 1);
});

test('startup failure preserves the previous manifest byte for byte', t => {
  const f = fixture(t);
  const old = '{"fileName":"CardBushProcessHost-0000000000000000.exe","sandboxVersion":1}\n';
  f.write('dist-native/process-guard/current.json', old);
  f.write('dist-native/process-guard/CardBushProcessHost-0000000000000000.exe', 'previous host');
  f.build(true);
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), old);
  assert.throws(() => f.build(), /could not pass its startup check/);
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), old);
  assert.equal(fs.existsSync(f.receipt), false, 'a strict build cannot reuse a development receipt');
  assert.equal(f.state.compiles, 1, 'a denied executable is not recompiled or renamed on every retry');
});

test('successful retry verifies the existing executable and publishes it atomically', t => {
  const f = fixture(t);
  f.build(true);
  f.ready();
  fs.rmSync(f.compiler); // A cached binary can be checked without a compiler installation.
  assert.deepEqual(f.build(), { available: true });
  const manifest = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  assert.equal(manifest.sandboxVersion, 1);
  assert.match(manifest.fileName, /^CardBushProcessHost-[a-f0-9]{16}\.exe$/);
  assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(guiBuildState(f.root, 'win32').current, true);
  assert.equal(f.state.compiles, 1);
  assert.equal(f.state.probes, 2);
});

test('development mode does not swallow compiler or capability/protocol failures', async t => {
  for (const failure of ['compiler', 'invalid-json', 'wrong-protocol', 'wrong-version', 'nonzero-exit']) {
    await t.test(failure, t => {
      const f = fixture(t);
      if (failure === 'compiler') f.state.compileError = true;
      else {
        f.ready();
        if (failure === 'invalid-json') f.state.probe.stdout = 'invalid';
        if (failure === 'wrong-protocol') f.state.probe.stdout = '{"protocol":"other","sandboxVersion":1}';
        if (failure === 'wrong-version') f.state.probe.stdout = '{"protocol":"cardbush.process-host.v1","sandboxVersion":2}';
        if (failure === 'nonzero-exit') f.state.probe.status = 1;
      }
      assert.throws(() => f.build(true), failure === 'compiler' ? /compilation failed/ : /startup check/);
      assert.equal(fs.existsSync(f.manifest), false);
      assert.equal(fs.existsSync(f.receipt), false);
    });
  }
});

test('receipt freshness covers every native source and both builder files', async t => {
  for (const file of ['native/process-guard/CardBushProcessHost.cs', 'native/process-guard/ProcessSandbox.cs',
    'scripts/build-process-resource-host.mjs', 'scripts/lib/process-host-build.mjs']) {
    await t.test(file, t => {
      const f = fixture(t);
      f.build(true);
      f.write(file, 'changed');
      assert.equal(unavailableProcessHostBuild(f.root), undefined);
      assert.equal(guiBuildState(f.root, 'win32').current, false);
    });
  }
});

test('missing or modified executables and malformed receipts cannot suppress a rebuild', async t => {
  for (const damage of ['missing-executable', 'changed-executable', 'invalid-receipt']) {
    await t.test(damage, t => {
      const f = fixture(t);
      f.build(true);
      const receipt = unavailableProcessHostBuild(f.root);
      const executable = path.join(path.dirname(f.manifest), receipt.fileName);
      if (damage === 'missing-executable') fs.rmSync(executable);
      if (damage === 'changed-executable') fs.writeFileSync(executable, 'damaged');
      if (damage === 'invalid-receipt') fs.writeFileSync(f.receipt, '{}');
      assert.equal(unavailableProcessHostBuild(f.root), undefined);
      assert.equal(guiBuildState(f.root, 'win32').current, false);
    });
  }
});

test('native sandbox source changes invalidate successful builds too; non-Windows skips native checks', t => {
  const f = fixture(t);
  f.ready();
  f.build();
  const source = f.write('native/process-guard/ProcessSandbox.cs', 'changed sandbox');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(source, future, future);
  assert.equal(guiBuildState(f.root, 'win32').current, false);
  assert.equal(guiBuildState(f.root, 'linux').current, true);
  assert.equal(buildProcessResourceHost({ ...f.options, platform: 'linux' }), undefined);
  assert.equal(f.state.probes, 1);
});

test('independent plugins and ignored output from removed workspaces do not force endless GUI rebuilds', t => {
  const f = fixture(t);
  f.ready();
  f.build();
  const removed = f.write('packages/removed-plugin/dist/index.js', 'stale ignored output');
  fs.utimesSync(removed, new Date(0), new Date(0));
  f.write('packages/team-plugin/package.json', '{"name":"independent-team-plugin"}');
  const independent = f.write('packages/team-plugin/dist/index.js', 'separately built plugin');
  fs.utimesSync(independent, new Date(0), new Date(0));
  assert.equal(guiBuildState(f.root, 'win32').current, true);
  f.write('packages/active-plugin/package.json', '{"name":"active-plugin"}');
  assert.equal(guiBuildState(f.root, 'win32').current, false, 'current workspaces still require their outputs');
});
