import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { getConfig, validateConfiguration } from 'app-builder-lib/out/util/config/config.js';
import { collectWindowsBinaries, requireValidSignatures } from './verify-windows-signatures.mjs';

test('release inventory includes nested helpers, DLLs and native modules, but not foreign native binaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-signature-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'resources', 'plugin'), { recursive: true });
  const names = ['CardBush.exe', 'resources/plugin/helper.exe', 'resources/plugin/compute.dll', 'resources/plugin/native.node'];
  for (const name of names) await writeFile(join(root, name), 'MZfixture');
  await writeFile(join(root, 'resources/plugin/linux.node'), '\x7fELFfixture');
  assert.deepEqual(await collectWindowsBinaries(root), names.map(name => join(root, name)).sort());
});

test('unsigned, damaged, missing and non-RSA signatures block release instead of silently passing', () => {
  const file = resolve('helper.exe');
  const valid = { path: file, status: 'Valid', keyAlgorithm: '1.2.840.113549.1.1.1' };
  assert.deepEqual(requireValidSignatures([file], [valid]), { verified: 1 });
  for (const entry of [{ ...valid, status: 'NotSigned' }, { ...valid, status: 'HashMismatch' }, { ...valid, keyAlgorithm: '1.2.840.10045.2.1' }]) {
    assert.throws(() => requireValidSignatures([file], [entry]), /signature check failed/);
  }
  assert.throws(() => requireValidSignatures([file], []), /missing verification/);
  assert.throws(() => requireValidSignatures([], []), /No Windows binaries/);
});

test('user Windows installers enforce signing; development and Store upload staging remain separate', async () => {
  const profile = await getConfig(process.cwd(), 'electron-builder.release.yml');
  await validateConfiguration(profile, { debugLogger: { isEnabled: false } });
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(profile.win.forceCodeSigning, true);
  assert.deepEqual(profile.win.signExts, ['.exe', '.dll', '.node']);
  assert.ok(packageJson.scripts['package:win'].includes('electron-builder.release.yml'));
  assert.ok(!packageJson.scripts['package:dir'].includes('electron-builder.release.yml'));
  assert.equal(profile.afterSign, 'scripts/windows-release-signature-check.cjs');
  assert.equal(profile.artifactBuildCompleted, profile.afterSign);
  assert.ok(profile.win.extraResources.some(resource => resource.to === 'process-guard'));
  for (const extension of ['exe', 'dll', 'node']) assert.ok(profile.asarUnpack.includes(`**/*.${extension}`));
});

test('public tag releases cannot use the unsigned development installer path', async () => {
  const workflow = yaml.load(await readFile(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8'));
  const installers = workflow.jobs.build.steps.filter(step => step.run?.includes('--win nsis'));
  const signed = installers.filter(step => step.run.includes('electron-builder.release.yml'));
  assert.equal(signed.length, 1);
  assert.equal(signed[0].if, "runner.os == 'Windows' && startsWith(github.ref, 'refs/tags/v')");
  assert.equal(signed[0].env.WIN_CSC_LINK, '${{ secrets.WIN_CSC_LINK }}');
  assert.equal(signed[0].env.WIN_CSC_KEY_PASSWORD, '${{ secrets.WIN_CSC_KEY_PASSWORD }}');
  const unsigned = installers.filter(step => !step.run.includes('electron-builder.release.yml'));
  assert.equal(unsigned.length, 1);
  assert.equal(unsigned[0].if, "runner.os == 'Windows' && !startsWith(github.ref, 'refs/tags/v')");
  assert.equal(workflow.jobs.publish.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(workflow.jobs.publish.needs, 'build');
});
