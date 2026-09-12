import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { TeamConfigurationFileStore } from '../packages/cardbush-team-plugin/dist/configStore.js';
import { resolve } from 'node:path';
import { TeamSnapshotStore } from '../packages/cardbush-team-plugin/dist/teamSnapshotStore.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const revisionKey = 'cardbush_product_team_revision_v1';
const tool = name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const baseTools = [tool('read_file')];
const pluginTools = [...baseTools, tool('mcp__example__read')];

const filesRoot = await mkdtemp(join(tmpdir(), 'cardbush-team-config-tests-'));
const files = new WeakMap();
let fileSequence = 0;
after(async () => {
  assert.ok(filesRoot.startsWith(tmpdir() + sep));
  await rm(filesRoot, { recursive: true, force: true });
});

async function loadProduct(storage) {
  if (!files.has(storage)) files.set(storage, new TeamConfigurationFileStore(join(filesRoot, String(++fileSequence), 'teams.json')));
  const file = files.get(storage);
  return loadChatTranscript({
    globals: { structuredClone, TextEncoder, window: {
      cardbushDesktop: { teamConfiguration: async input => structuredClone(await (input.action === 'read'
        ? file.read(input.migration) : file.write(input.configuration, input.expectedHash))) },
      localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    } } },
    source: `import { setHost } from ${JSON.stringify(resolve('packages/cardbush-team-plugin/ui/host.ts'))}; setHost({command: (_kind,input) => window.cardbushDesktop.teamConfiguration(input)});\n` + ['packages/cardbush-team-plugin/ui/productTeams.ts', 'src/runtime-client/ProtocolRuntimeClient.ts']
      .map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'),
  });
}

async function fixture() {
  const storage = new Map();
  const product = await loadProduct(storage);
  const state = { active: false, legacy: false, loseResponse: false, beforeApply: undefined };
  state.store = new TeamSnapshotStore({ canApply: () => !state.active });
  const applied = [];
  const createClient = (module = product) => new module.ProtocolRuntimeClient({
    async *openEventStream() {},
    async sendCommand(command) {
      let result;
      if (command.kind === 'runtime.get_team_snapshot') {
        result = state.store.result() ?? null;
      } else if (command.kind === 'runtime.apply_team_snapshot') {
        await state.beforeApply?.(command.payload);
        result = state.store.apply(command.payload);
        applied.push(structuredClone(command.payload));
        if (state.loseResponse) { state.loseResponse = false; throw new Error('fixture lost apply response'); }
      } else throw new Error(`Unexpected command: ${command.kind}`);
      if (state.legacy && result) delete result.contentHash;
      return result;
    },
  });
  return { storage, product, state, applied, createClient, client: createClient() };
}

async function configuration(product, tools = baseTools) {
  return { ...(await product.readProductTeamConfiguration()).configuration, tools };
}

test('plugin tool addition and removal advance revisions; reordered and duplicate names are idempotent', async () => {
  const { product, client, state, applied, storage } = await fixture();
  assert.equal((await product.synchronizeProductTeamSnapshot(client, baseTools)).revision, 1);
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 2);
  const reversed = [...pluginTools].reverse();
  assert.equal((await product.synchronizeProductTeamSnapshot(client, [...reversed, reversed[0]])).revision, 2);
  assert.equal(applied.length, 2, 'unchanged effective content must not be reapplied');
  assert.deepEqual(state.store.team('general').members[0].toolNames, ['mcp__example__read', 'read_file']);
  assert.equal((await product.synchronizeProductTeamSnapshot(client, baseTools)).revision, 3);
  assert.deepEqual(state.store.team('general').members[0].toolNames, ['read_file']);
  assert.deepEqual(reversed.map(item => item.name), ['mcp__example__read', 'read_file'], 'caller catalog is not sorted in place');
  assert.deepEqual([...storage.keys()], [revisionKey], 'no second catalog or fingerprint is persisted');
});

test('only effective constraints advance the revision, and disabled tools remain excluded', async () => {
  const { product, client, state, applied } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  const config = await configuration(product);
  config.profiles[0].disabledTools = ['mcp__example__read'];
  assert.equal((await product.replaceProductTeamConfiguration(client, config)).revision, 1);
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 1);
  assert.equal(applied.length, 1);
  const updated = await configuration(product, pluginTools);
  updated.profiles[0].prompts.instructions = 'Use verified evidence. 中文约束';
  updated.profiles[0].skills = ['review'];
  assert.equal((await product.replaceProductTeamConfiguration(client, updated)).revision, 2);
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 2);
  assert.equal(state.store.team('general').members[0].promptInstructions, 'Use verified evidence. 中文约束');
  assert.deepEqual(state.store.team('general').members[0].toolNames, ['read_file']);
  assert.deepEqual(state.store.team('general').members[0].skills, ['review']);
  updated.profiles[0].disabledTools = [];
  assert.equal((await product.replaceProductTeamConfiguration(client, updated)).revision, 3);
  assert.deepEqual(state.store.team('general').members[0].toolNames, ['mcp__example__read', 'read_file']);
});

test('different per-turn clients serialize revision allocation against the shared Runtime', async () => {
  const { product, createClient, applied } = await fixture();
  const results = await Promise.all([
    product.synchronizeProductTeamSnapshot(createClient(), baseTools),
    product.synchronizeProductTeamSnapshot(createClient(), pluginTools),
    product.synchronizeProductTeamSnapshot(createClient(), [...pluginTools].reverse()),
  ]);
  assert.deepEqual(results.map(result => result.revision), [1, 2, 2]);
  assert.deepEqual(applied.map(snapshot => snapshot.revision), [1, 2]);
});

test('active turns allow reads of unchanged snapshots but still reject actual changes', async () => {
  const { product, client, state, storage, applied } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  state.active = true;
  assert.equal((await product.synchronizeProductTeamSnapshot(client, baseTools)).revision, 1);
  await assert.rejects(product.synchronizeProductTeamSnapshot(client, pluginTools), /Turn is active/);
  assert.equal(storage.get(revisionKey), '1');
  assert.equal(state.store.result().revision, 1);
  assert.equal(applied.length, 1);
  state.active = false;
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 2);
});

test('a lost apply response and renderer restart recover from the Runtime receipt without version churn', async () => {
  const { product, client, state, storage, applied, createClient } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  state.loseResponse = true;
  await assert.rejects(product.synchronizeProductTeamSnapshot(client, pluginTools), /lost apply response/);
  assert.equal(storage.get(revisionKey), '1', 'failed delivery does not commit a local revision');
  assert.equal(state.store.result().revision, 2, 'the Runtime did accept the update');
  const reloaded = await loadProduct(storage);
  assert.equal((await reloaded.synchronizeProductTeamSnapshot(createClient(reloaded), pluginTools)).revision, 2);
  assert.equal(applied.length, 2, 'recovery observes the accepted update instead of applying it again');
  assert.equal(storage.get(revisionKey), '2');
  assert.equal((await reloaded.synchronizeProductTeamSnapshot(createClient(reloaded), baseTools)).revision, 3);
});

test('Runtime restart reapplies the current content at the persisted revision floor', async () => {
  const { product, client, state, applied } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  await product.synchronizeProductTeamSnapshot(client, pluginTools);
  state.store = new TeamSnapshotStore();
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 2);
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 2);
  assert.deepEqual(applied.map(snapshot => snapshot.revision), [1, 2, 2]);
  assert.equal((await product.synchronizeProductTeamSnapshot(client, baseTools)).revision, 3);
});

test('existing snapshots from an older host advance safely without an available content hash', async () => {
  const { product, client, state, storage, applied } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, pluginTools);
  const legacy = structuredClone(applied[0]);
  legacy.revision = 8;
  legacy.teams[0].members[0].toolNames.reverse();
  state.store.apply(legacy);
  state.legacy = true;
  assert.equal(storage.get(revisionKey), '1');
  assert.equal((await product.synchronizeProductTeamSnapshot(client, pluginTools)).revision, 9);
  assert.equal(state.store.result().revision, 9);
  state.legacy = false;
  assert.equal((await product.synchronizeProductTeamSnapshot(client, [...pluginTools].reverse())).revision, 9);
});

test('failed configuration saves leave the file unchanged before a queued send reads the team', async () => {
  const { product, client, state, storage } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  const before = new Map(storage);
  const config = await configuration(product);
  config.teams[0].name = 'Rejected edit';
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  state.beforeApply = async () => { entered(); await blocked; throw new Error('fixture rejected configuration'); };
  const save = product.replaceProductTeamConfiguration(client, config);
  const failedSave = assert.rejects(save, /rejected configuration/);
  await started;
  const send = product.synchronizeProductTeamSnapshot(client, baseTools);
  release();
  await failedSave;
  assert.equal((await send).revision, 1);
  assert.deepEqual(storage, before);
  assert.equal((await product.readProductTeams())[0].name, 'General Team');
  assert.equal(state.store.team('general').name, 'General Team');
  state.beforeApply = undefined;
  assert.equal((await product.replaceProductTeamConfiguration(client, config)).revision, 2);
});

test('a successful save is visible to a queued send and invalid saves leave both sides intact', async () => {
  const { product, client, state, storage } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  const config = await configuration(product);
  config.teams[0].name = 'Saved team';
  const results = await Promise.all([
    product.replaceProductTeamConfiguration(client, config),
    product.synchronizeProductTeamSnapshot(client, pluginTools),
  ]);
  assert.deepEqual(results.map(result => result.revision), [2, 3]);
  assert.equal(state.store.team('general').name, 'Saved team');
  const before = new Map(storage);
  const invalid = await configuration(product, pluginTools);
  invalid.teams[0].members[0].agentProfileId = 'missing';
  await assert.rejects(product.replaceProductTeamConfiguration(client, invalid), /Missing Agent Profile/);
  assert.deepEqual(storage, before);
  assert.equal(state.store.result().revision, 3);
  assert.equal((await product.resetProductTeamConfiguration(client, baseTools)).revision, 4);
  assert.equal(state.store.team('general').name, 'General Team');
});

test('an uncertain save leaves the file unchanged and the next send reconciles forward', async () => {
  const { product, client, state, storage } = await fixture();
  await product.synchronizeProductTeamSnapshot(client, baseTools);
  const before = new Map(storage);
  const config = await configuration(product);
  config.teams[0].name = 'Unconfirmed team';
  state.loseResponse = true;
  await assert.rejects(product.replaceProductTeamConfiguration(client, config), /lost apply response/);
  assert.deepEqual(storage, before);
  assert.equal(state.store.team('general').name, 'Unconfirmed team');
  assert.equal((await product.synchronizeProductTeamSnapshot(client, baseTools)).revision, 3);
  assert.equal(state.store.team('general').name, 'General Team');
});
