import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { TeamConfigurationFileStore, encodeTeamConfigurationFile, decodeTeamConfigurationFile } from '../dist/configStore.js';
import { defaultTeamConfiguration } from '../dist/configuration.js';

const root = await mkdtemp(join(tmpdir(), 'cardbush-team-files-'));
let sequence = 0;
const store = extension => new TeamConfigurationFileStore(join(root, `teams-${++sequence}.${extension ?? 'json'}`));
after(async () => { assert.ok(root.startsWith(tmpdir() + sep)); await rm(root, { recursive: true, force: true }); });

test('configuration roundtrips JSON and YAML with Unicode and explicit empty skills', async () => {
  const source = defaultTeamConfiguration();
  source.profiles[0].skills = [];
  source.profiles[0].prompts.instructions = '基于证据\n逐条检查: "事实"';
  for (const format of ['json', 'yaml']) {
    assert.deepEqual(decodeTeamConfigurationFile(encodeTeamConfigurationFile(source, format)), source);
    const file = store(format);
    const created = await file.read(source);
    assert.equal(created.path, file.path);
    assert.deepEqual((await file.read()).configuration, source);
    const changed = structuredClone(source); changed.teams[0].name = 'Edited';
    const saved = await file.write(changed, created.contentHash);
    assert.notEqual(saved.contentHash, created.contentHash);
    assert.deepEqual(decodeTeamConfigurationFile(await readFile(file.path, 'utf8')), changed);
  }
});

test('existing file wins over legacy migration, and malformed files are never reset silently', async () => {
  const file = store();
  const legacy = defaultTeamConfiguration(); legacy.teams[0].name = 'Legacy choice';
  const first = await file.read(legacy);
  assert.equal(first.configuration.teams[0].name, 'Legacy choice');
  assert.deepEqual(await file.read({ invalid: true }), first);
  await writeFile(file.path, '{ broken');
  await assert.rejects(file.read(legacy));
  assert.equal(await readFile(file.path, 'utf8'), '{ broken');
});

test('GUI write rejects a changed file even if only formatting changed', async () => {
  const file = store();
  const receipt = await file.read();
  const manual = JSON.stringify(receipt.configuration);
  await writeFile(file.path, manual);
  await assert.rejects(file.write(receipt.configuration, receipt.contentHash), /changed on disk/);
  assert.equal(await readFile(file.path, 'utf8'), manual);
  await assert.rejects(file.write(receipt.configuration, ''), /changed on disk/);
});

test('two store instances cannot overwrite a concurrent successful save', async () => {
  const file = store();
  const receipt = await file.read();
  const next = structuredClone(receipt.configuration); next.teams[0].name = 'First save';
  const competing = structuredClone(next); competing.teams[0].name = 'Second save';
  const other = new TeamConfigurationFileStore(file.path);
  const results = await Promise.allSettled([file.write(next, receipt.contentHash), other.write(competing, receipt.contentHash)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.match(String(failure.reason), /changed on disk/);
  assert.deepEqual((await file.read()).configuration, results.find(result => result.status === 'fulfilled').value.configuration);
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('validation rejects duplicate IDs, dangling members, executable YAML tags and oversized input', async () => {
  const file = store();
  const receipt = await file.read();
  for (const mutate of [
    value => value.teams.push(structuredClone(value.teams[0])),
    value => value.profiles.push(structuredClone(value.profiles[0])),
    value => value.teams[0].members.push(structuredClone(value.teams[0].members[0])),
    value => { value.teams[0].members[0].agentProfileId = 'missing'; },
    value => { value.profiles[0].commands = ['unrecognized']; },
  ]) {
    const invalid = structuredClone(receipt.configuration); mutate(invalid);
    await assert.rejects(async () => file.write(invalid, receipt.contentHash));
    assert.equal((await file.read()).contentHash, receipt.contentHash);
  }
  assert.throws(() => decodeTeamConfigurationFile('!!js/function function() { return 1; }'));
  assert.throws(() => decodeTeamConfigurationFile('x'.repeat(2_000_001)), /2 MB/);
  assert.throws(() => new TeamConfigurationFileStore('relative.json'), /absolute/);
});
