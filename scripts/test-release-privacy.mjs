import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '@electron/asar';
import { auditPackagePrivacy, privatePackagePath, privateKeyContent } from './audit-package-privacy.mjs';
import { signingReadiness } from './check-windows-release.mjs';
import { verifyPackagedDependencies } from './verify-packaged-dependencies.mjs';

test('release preflight fails early without credentials and never echoes signing secrets', () => {
  const config = { win: { forceCodeSigning: true } };
  assert.throws(() => signingReadiness(config, {}), /signing is not configured/);
  assert.throws(() => signingReadiness({ win: {} }, { WIN_CSC_LINK: 'secret' }), /forceCodeSigning/);
  assert.deepEqual(signingReadiness(config, { WIN_CSC_LINK: 'private-pfx-bytes', WIN_CSC_KEY_PASSWORD: 'secret' }), { configured: true, verified: false });
  assert.deepEqual(signingReadiness({ win: { ...config.win, signtoolOptions: { certificateSha1: 'certificate-id' } } }, {}), { configured: true, verified: false });
});

test('package checks distinguish private material from public certificates and parser source code', () => {
  for (const name of ['assets/cert.pfx', 'assets/cert.p12', 'resources/.env', 'a/.env.production', 'runtime-state/session.json', 'x/.ssh/id_rsa', 'packaging/msix/identity.local.json']) assert.equal(privatePackagePath(name), true, name);
  for (const name of ['assets/logo.png', 'a/.env.example', 'public-cert.pem', 'src/connections.js']) assert.equal(privatePackagePath(name), false, name);
  assert.equal(privateKeyContent(Buffer.from("const marker = '-----BEGIN PRIVATE KEY-----';")), false);
  for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    const pem = `-----BEGIN ${kind}-----\n${'A'.repeat(128)}\n-----END ${kind}-----`;
    assert.equal(privateKeyContent(Buffer.from(pem)), true);
    assert.equal(privateKeyContent(Buffer.from(JSON.stringify({ value: pem }))), true);
  }
});

test('staged archives and unpacked resources are both inspected, with no key bytes in diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-package-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), staged = join(root, 'staged');
  await mkdir(source); await mkdir(staged);
  await writeFile(join(source, 'safe.js'), 'export const value = 1;');
  await createPackage(source, join(staged, 'app.asar'));
  assert.ok((await auditPackagePrivacy(staged)).inspected >= 2);
  await writeFile(join(source, 'hidden.json'), JSON.stringify({ certificate: '-----BEGIN PRIVATE KEY-----\n' + 'SecretBytes'.repeat(20) + '\n-----END PRIVATE KEY-----' }));
  await createPackage(source, join(staged, 'app.asar'));
  await assert.rejects(auditPackagePrivacy(staged), error => /hidden.json/.test(error.message) && !error.message.includes('SecretBytes'));
  await rm(join(source, 'hidden.json')); await createPackage(source, join(staged, 'app.asar'));
  await writeFile(join(staged, 'publisher.pfx'), 'secret');
  await assert.rejects(auditPackagePrivacy(staged), /publisher.pfx/);
});

test('a valid ASAR without production dependencies cannot pass the packaging gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-package-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), archive = join(root, 'app.asar');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ dependencies: { ssh2: '^1.17.0' } }));
  await createPackage(source, archive);
  assert.throws(() => verifyPackagedDependencies(archive), /ssh2, sharp/);
  for (const name of ['ssh2', 'sharp']) {
    await mkdir(join(source, 'node_modules', name), { recursive: true });
    await writeFile(join(source, 'node_modules', name, 'package.json'), JSON.stringify({ name }));
  }
  await createPackage(source, archive);
  assert.equal(verifyPackagedDependencies(archive).verified, 1);
});
