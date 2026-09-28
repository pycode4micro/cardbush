import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computerUseFailure } from '../dist/plugins/computerUseErrors.js';
import { ComputerUseSafetyGuard } from '../dist/plugins/computerUseRuntime.js';
import { prepareComputerUsePresentation } from '../dist/plugins/computerUsePresentation.js';

test('application control has a terminal recovery message, with no generic retry advice', () => {
  for (const message of ['Add-Type: An Application Control policy has blocked this file. (HRESULT:0x800711C7)',
    '本地组件无法加载，HRESULT:0x800704EC', 'Windows rejected the signature (0x80070241)']) {
    const error = computerUseFailure(new Error(message), 'unknown');
    assert.equal(error.info.code, 'application_control_blocked');
    assert.equal(error.info.execution, 'unknown');
    assert.equal(error.info.message, message);
    assert.match(error.info.recovery, /Do not retry/);
    assert.doesNotMatch(error.info.recovery, /obtain a fresh observation/i);
  }
  for (const message of ['Access denied', 'spawn UNKNOWN', 'DLL not found', 'The window requires focus']) {
    assert.notEqual(computerUseFailure(new Error(message)).info.code, 'application_control_blocked');
  }
});

test('OS rejection ends retries in the same turn, preserves finish, and leaves a new turn available', () => {
  const guard = new ComputerUseSafetyGuard();
  const release = guard.begin('session:turn1', { action: 'observe' });
  guard.recordApplicationControlBlock('session:turn1', computerUseFailure(new Error('HRESULT:0x800711C7'), 'unknown'));
  release();
  guard.releaseObservation('session:turn1');
  for (const action of ['observe', 'screenshot', 'open_app', 'click']) {
    assert.throws(() => guard.begin('session:turn1', { action, hwnd: 2 }), error =>
      error.info.code === 'application_control_blocked' && error.info.execution === 'not_dispatched');
  }
  guard.begin('session:turn2', { action: 'observe' })();
});

test('packaged native libraries never fall back to compiling an unsigned DLL on the user machine', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-packaged-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const plugins = join(root, 'app.asar', 'plugins');
  await mkdir(plugins, { recursive: true });
  for (const file of ['computerUseNativeCode.js', 'computerUseTimings.js']) {
    await copyFile(new URL('../dist/plugins/' + file, import.meta.url), join(plugins, file));
  }
  const { prepareComputerUseNativeCode } = await import(pathToFileURL(join(plugins, 'computerUseNativeCode.js')));
  await assert.rejects(prepareComputerUseNativeCode("Add-Type -TypeDefinition @'\npublic class Missing {}\n'@"), /signed releases must not compile unsigned replacement/);
});

test('the presentation worker is compiled before release and loads a fixed DLL', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-presentation-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await prepareComputerUsePresentation(root);
  assert.doesNotMatch(script, /Add-Type[^\n]*-TypeDefinition/);
  assert.match(script, /\[CardBushPresentation\]::Run\(\)/);
  const literalPath = script.match(/Add-Type -Path '((?:''|[^'])+)'/)?.[1];
  assert.ok(literalPath, 'worker must load a precompiled assembly');
  const bytes = await readFile(literalPath.replaceAll("''", "'"));
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  assert.equal(await prepareComputerUsePresentation(root), script, 'the worker reuses its immutable release library');
});
