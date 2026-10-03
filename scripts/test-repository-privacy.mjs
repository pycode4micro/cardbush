import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';

// Scan only publishable source, never ignored user profiles or release outputs.
const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' }).split('\0').filter(path => path && existsSync(path)))];
const text = path => readFileSync(path, 'utf8');
const tlsFixture = 'scripts/fixtures/plugin-proxy-tls/key.pem';

test('publishable files exclude local credentials and deployment state', () => {
  const privatePath = /(?:^|\/)(?:\.env(?:\.|$)|id_rsa$|id_ed25519$)|\.local\.json$|\.(?:pfx|p12|key)$|^(?:private-release|deploy\/agent\/data|release-msix)\//i;
  assert.deepEqual(paths.filter(path => privatePath.test(path) && !/\.env(?:\.[\w-]+)?\.example$/.test(path)), []);
  const inputs = ['.env', '.env.production', 'packaging/msix/identity.local.json', 'packaging/windows/signing.local.json',
    'deploy/agent/data/accounts.json', 'private-release/report.json', 'release-msix/private.msix', 'private.pfx'];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { input: inputs.join('\n'), encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(ignored, inputs);
});

test('source has no embedded provider tokens or production private keys', () => {
  const rules = [
    ['provider token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{80,}/],
  ];
  const failures = [];
  for (const path of paths) {
    const source = text(path);
    if (source.includes('\0')) continue;
    for (const [name, expression] of rules) {
      if (!expression.test(source)) continue;
      // This already-public, self-signed loopback fixture is not an account or
      // signing credential. Pin exact bytes so this cannot hide a replacement key.
      if (name === 'private key' && path === tlsFixture &&
          createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex') === 'be4be4c9d66eab719b7ccab1a54bf814bc131afb3d3de53f62411e0bc520061d') continue;
      failures.push(`${path}: ${name}`); // Never echo matched credentials.
    }
  }
  assert.deepEqual(failures, []);
  const certificate = new X509Certificate(text('scripts/fixtures/plugin-proxy-tls/cert.pem'));
  assert.equal(certificate.subject, 'CN=CardBush proxy test only');
  assert.equal(certificate.subjectAltName, 'IP Address:127.0.0.1');
  assert.ok(certificate.verify(certificate.publicKey));
  assert.ok(certificate.checkPrivateKey(createPrivateKey(text(tlsFixture))));
});

test('public MSIX summaries contain redacted identities and no exact artifact hashes', () => {
  for (const path of paths.filter(path => /^docs\/validation\/msix-.*\.json$/.test(path))) {
    const source = text(path), report = JSON.parse(source);
    assert.ok(report.redaction, `${path}: missing redaction notice`);
    assert.ok(!/CN=[0-9a-f]{8}-|\b[0-9a-f]{64}\b|S-1-5-21-\d|\w+_\d+\.\d+\.\d+\.\d+_(?:x64|x86|arm64)__\w+/i.test(source),
      `${path}: private release evidence must stay local`);
  }
});

test('application examples and test fixtures use generic profile names', () => {
  const allowed = /^(?:fixture|test|tester|user|username|public|default|example|\.{3})$/i;
  const failures = [];
  for (const path of paths.filter(path => /^(?:scripts|src)\//.test(path) && /\.(?:[cm]?js|tsx?)$/.test(path))) {
    for (const match of text(path).matchAll(/(?:[A-Z]:)?[\\/]+Users[\\/]+([\w.-]+)/gi)) {
      if (!allowed.test(match[1])) failures.push(path);
    }
  }
  assert.deepEqual([...new Set(failures)], []);
});
