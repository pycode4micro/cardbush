import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { correctLegacyIssuer, legacyIssuerPatch, sha256, verifyOfficialBundle } from './mcp-conformance/legacy-issuer-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { scenario: { type: 'string', multiple: true }, output: { type: 'string' },
  suite: { type: 'string', default: 'core' }, 'fixture-mode': { type: 'string', default: 'corrected' } } });
// Official 0.1.16 client core + released authorization backcompat. Extensions
// and draft-spec scenarios are reported as out of scope, never counted as passes.
const scenarios = [
  'initialize', 'tools_call', 'elicitation-sep1034-client-defaults', 'sse-retry',
  'auth/metadata-default', 'auth/metadata-var1', 'auth/metadata-var2', 'auth/metadata-var3',
  'auth/basic-cimd', 'auth/scope-from-www-authenticate', 'auth/scope-from-scopes-supported',
  'auth/scope-omitted-when-undefined', 'auth/scope-step-up', 'auth/scope-retry-limit',
  'auth/token-endpoint-auth-basic', 'auth/token-endpoint-auth-post', 'auth/token-endpoint-auth-none',
  'auth/pre-registration', 'auth/2025-03-26-oauth-metadata-backcompat', 'auth/2025-03-26-oauth-endpoint-fallback',
];
if (!['core', 'backcompat', 'all'].includes(values.suite)) throw new Error('Choose --suite core, backcompat, or all.');
if (!['corrected', 'upstream'].includes(values['fixture-mode'])) throw new Error('Choose --fixture-mode corrected or upstream.');
const selected = values.scenario ?? scenarios.filter(name => values.suite === 'all' ||
  (values.suite === 'backcompat') === name.startsWith('auth/2025-03-26-'));
for (const name of selected) if (!scenarios.includes(name)) throw new Error(`Unsupported scenario: ${name}`);
if (new Set(selected).size !== selected.length) throw new Error('Each scenario may only be selected once.');
const suiteRoot = join(root, 'node_modules/@modelcontextprotocol/conformance');
const suite = JSON.parse(await readFile(join(suiteRoot, 'package.json'), 'utf8'));
if (suite.version !== '0.1.16') throw new Error('Review scenario coverage before changing the pinned conformance version.');
const suiteBundle = await readFile(join(suiteRoot, 'dist/index.js'), 'utf8');
verifyOfficialBundle(suiteBundle);
const applyFixtureCorrection = values['fixture-mode'] === 'corrected' && selected.includes(legacyIssuerPatch.scenario);
const fixtureCorrections = applyFixtureCorrection ? [{ ...legacyIssuerPatch,
  correctedSha256: sha256(correctLegacyIssuer(suiteBundle)),
  sourcePatchSha256: sha256(await readFile(join(root, legacyIssuerPatch.sourcePatch))),
}] : [];
const output = resolve(values.output ?? join(root, 'tmp/mcp-conformance', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Never combine checks from a previous run with this run.
const report = { suite: suite.name, version: suite.version, startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, driver: 'CardBush McpClientManager + McpOAuthCoordinator',
  fixtureMode: values['fixture-mode'], upstreamBundleSha256: sha256(suiteBundle), fixtureCorrections,
  sourceHashes: {}, scenarios: [], excluded: { draft: 3, extensions: 3, released: scenarios.filter(name => !selected.includes(name)) },
};
for (const path of ['packages/bush-mcp-client/src/index.ts', 'packages/bush-mcp-client/src/oauth.ts',
  'packages/bush-mcp-client/src/elicitation.ts', 'packages/bush-mcp-client/dist/index.js',
  'packages/bush-mcp-client/dist/oauth.js', 'packages/bush-mcp-client/dist/elicitation.js',
  'scripts/mcp-conformance-client.mjs', 'scripts/run-mcp-conformance.mjs',
  'scripts/mcp-conformance/legacy-issuer-patch.mjs', 'scripts/mcp-conformance/fixture-loader.mjs', 'package-lock.json']) {
  report.sourceHashes[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
async function findChecks(directory) {
  const found = [], outcomes = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await findChecks(path); found.push(...child.checks); outcomes.push(...child.outcomes);
    }
    else if (entry.name === 'checks.json') found.push(...JSON.parse(await readFile(path, 'utf8')));
    else if (entry.name === 'stdout.txt') {
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        try { const value = JSON.parse(line); if (value.scenario) outcomes.push(value); } catch { /* SDK logging is not a driver outcome. */ }
      }
    }
  }
  return { checks: found, outcomes };
}
for (const scenario of selected) {
  const directory = join(output, scenario.replaceAll('/', '__'));
  await mkdir(directory, { recursive: true });
  console.log(`Running ${scenario}`);
  const started = Date.now();
  const command = `"${process.execPath}" "${join(root, 'scripts/mcp-conformance-client.mjs')}"`;
  const fixtureCorrection = applyFixtureCorrection && scenario === legacyIssuerPatch.scenario ? legacyIssuerPatch.id : null;
  const loader = fixtureCorrection ? ['--import', pathToFileURL(join(root, 'scripts/mcp-conformance/fixture-loader.mjs')).href] : [];
  const child = spawn(process.execPath, [...loader, join(suiteRoot, 'dist/index.js'), 'client', '--command', command,
    '--scenario', scenario, '--timeout', '30000', '--output-dir', directory], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let runnerTimedOut = false;
  const timer = setTimeout(() => { runnerTimedOut = true; child.kill(); }, 45_000);
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  let code;
  try { code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); }); }
  finally { clearTimeout(timer); }
  await writeFile(join(directory, 'runner.log'), log);
  const { checks, outcomes } = await findChecks(directory);
  const failures = checks.filter(check => check.status === 'FAILURE' || check.status === 'WARNING');
  const driverCompleted = outcomes.some(item => item.scenario === scenario && item.completed === true);
  const fixtureCorrectionApplied = fixtureCorrection ? log.includes(`[CardBush fixture correction] ${fixtureCorrection}`) : false;
  const entry = { scenario, passed: !runnerTimedOut && code === 0 && checks.some(check => check.status === 'SUCCESS') && !failures.length && driverCompleted && (!fixtureCorrection || fixtureCorrectionApplied),
    fixtureCorrection, fixtureCorrectionApplied,
    driverCompleted, runnerTimedOut, exitCode: code,
    elapsedMs: Date.now() - started, checks: checks.filter(check => check.status === 'SUCCESS').length,
    failures: failures.map(({ id, status, description }) => ({ id, status, description })), directory };
  report.scenarios.push(entry);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${scenario} (${entry.elapsedMs}ms; ${entry.checks} checks)`);
}
report.completedAt = new Date().toISOString();
report.passed = report.scenarios.filter(item => item.passed).length;
report.failed = report.scenarios.length - report.passed;
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, fixtureCorrections: fixtureCorrections.map(item => item.id), report: join(output, 'report.json') }));
if (report.failed) process.exitCode = 1;
