import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileToolExecutionPersistence,
  ToolExecutionJournalCorruptionError,
  ToolExecutionStore,
} from "../dist/index.js";

test("persists native results and Runtime-owned workspace changes", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  const store = new ToolExecutionStore({ persistence, now: () => NOW });
  const saved = store.record(toolCall(), identity(), outcome());
  persistence.close();

  assert.deepEqual(saved.result.artifacts.map((item) => item.artifact_id), ["artifact_1"]);
  assert.deepEqual(saved.workspaceChanges.map((item) => item.change_id), ["change_1"]);
  const reopened = new FileToolExecutionPersistence({ root });
  const recovered = new ToolExecutionStore({ persistence: reopened });
  assert.equal(recovered.get("session_1", "turn_1", "call_1")?.result.value, "ok");
  assert.equal(recovered.listTurn("session_1", "turn_1").length, 1);
  reopened.close();
});

test("model text survives restart independently of native result data", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  const modelText = "original \\d+\r\n中文😀\n";
  const store = new ToolExecutionStore({ persistence, now: () => NOW });
  store.record(toolCall(), identity(), outcome(), modelText);
  assert.throws(() => store.record(toolCall(), identity(), outcome(), "different presentation"), /different record/);
  persistence.close();
  const reopened = new FileToolExecutionPersistence({ root });
  const recovered = new ToolExecutionStore({ persistence: reopened });
  assert.equal(recovered.get("session_1", "turn_1", "call_1").modelText, modelText);
  assert.deepEqual(recovered.get("session_1", "turn_1", "call_1").result, outcome().result);
  assert.equal("modelText" in recovered.listTurnSummaries("session_1", "turn_1")[0], false);
  reopened.close();
});

test('image lookup uses explicit native receipts without granting paths from text, arguments or failed tools', t => {
  const root = temporaryRoot(t);
  const image = { ...artifact(), path: join(root, 'capture.png') };
  const variants = [
    [{ artifacts: [image] }, true],
    [{ structuredContent: { artifacts: [image] } }, true],
    [{ mcp: { name: 'mcp__fixture__capture' }, result: { structuredContent: { artifacts: [image] } } }, true],
    [{ content: [{ type: 'text', text: JSON.stringify({ artifacts: [image] }) }] }, false],
    [{ path: image.path }, false],
    [{ result: { artifacts: [image] }, calls: 1 }, false],
    [{ artifacts: [{ ...image, type: 'file' }] }, false],
    [{ isError: true, artifacts: [image] }, false],
  ];
  const store = new ToolExecutionStore();
  for (const [index, [result, allowed]] of variants.entries()) {
    const sessionId = `session_${index}`;
    store.record({ ...toolCall(), argumentsText: JSON.stringify({ artifacts: [image] }) }, { ...identity(), sessionId },
      outcome({ result, workspaceChanges: [] }), JSON.stringify({ artifacts: [image] }));
    assert.equal(store.hasImageArtifact(sessionId, image.path), allowed, `variant ${index}`);
    assert.equal(store.hasImageArtifact(sessionId, join(root, 'other.png')), false);
    assert.equal(store.hasImageArtifact(sessionId, 'capture.png'), false);
  }
  assert.equal(store.hasImageArtifact('other_session', image.path), false);
  if (process.platform === 'win32') assert.equal(store.hasImageArtifact('session_0', image.path.toUpperCase().replaceAll('\\', '/')), true);
});

test('file transport resolves only successful host image and file memo receipts in this session', t => {
  const root = temporaryRoot(t), path = join(root, 'reference.png'), snapshot = join(root, 'model-images', 'snapshot.png');
  const imageResult = { artifacts: [{ type: 'image', path, metadata: { model_input: true, model_input_url: snapshot } }] };
  const memoResult = { protocol: 'bush.file_memo.v1', id: 'file_1', reference: 'cardbush-memo:1',
    file: { path, name: 'reference.png', size: 123, mtimeMs: 456 }, note: { purpose: 'delivery', points: [] } };
  const imageManifest = { protocol: 'bush.tool.action_manifest.v1', manifest_id: 'image',
    effect_kind: 'observation', operation: 'image.inject', owner: 'runtime', risk: 'low', dispatch_scope: 'session', mutating: false };
  const variants = [
    ['inject_image_input', imageResult, imageManifest, { kind: 'model_image', path: snapshot }],
    ['remember_file', memoResult, { ...imageManifest, operation: 'file_memo' }, { kind: 'file_memo', path, size: 123, mtimeMs: 456 }],
    ['mcp__plugin__image', imageResult, { ...imageManifest, owner: 'plugin' }, { kind: 'capture' }],
    ['mcp__plugin__memo', memoResult, imageManifest, undefined],
    ['run_tools', { result: memoResult }, imageManifest, undefined],
    ['inject_image_input', { isError: true, ...imageResult }, imageManifest, undefined],
    ['remember_file', { isError: true, ...memoResult }, { ...imageManifest, operation: 'file_memo' }, undefined],
    ['remember_file', memoResult, undefined, undefined],
  ];
  const persistence = new FileToolExecutionPersistence({ root: join(root, 'journal') });
  const store = new ToolExecutionStore({ persistence });
  for (const [index, [name, result, actionManifest, expected]] of variants.entries()) {
    const sessionId = `receipts_${index}`;
    store.record({ ...toolCall(), name, argumentsText: JSON.stringify(imageResult) }, { ...identity(), sessionId },
      outcome({ result, actionManifest, workspaceChanges: [] }), JSON.stringify(memoResult));
    assert.deepEqual(store.fileReceipt(sessionId, path), expected, name);
    assert.equal(store.fileReceipt(sessionId, snapshot), undefined, 'snapshot hash alone grants nothing');
    assert.equal(store.fileReceipt(sessionId, join(root, 'neighbor.png')), undefined);
    assert.equal(store.fileReceipt(sessionId, 'reference.png'), undefined);
  }
  assert.equal(store.fileReceipt('another_session', path), undefined);
  const updatedMemo = { ...memoResult, file: { ...memoResult.file, size: 124, mtimeMs: 789 } };
  store.record({ ...toolCall(), id: 'memo-revision', name: 'remember_file' }, { ...identity(), sessionId: 'receipts_1' },
    outcome({ result: updatedMemo, actionManifest: { ...imageManifest, operation: 'file_memo' }, workspaceChanges: [] }));
  assert.deepEqual(store.fileReceipt('receipts_1', path), { kind: 'file_memo', path, size: 124, mtimeMs: 789 }, 'the latest host revision wins');
  // Failed or cancelled calls cannot masquerade as an earlier successful read.
  for (const kind of ['failed', 'cancelled']) {
    store.record({ ...toolCall(), name: 'inject_image_input' }, { ...identity(), sessionId: kind },
      { kind, actionManifest: imageManifest, error: { kind: 'tool', code: kind, message: kind, details: {} }, workspaceChanges: [] });
    assert.equal(store.fileReceipt(kind, path), undefined);
  }
  persistence.close();
  const recoveredPersistence = new FileToolExecutionPersistence({ root: join(root, 'journal') });
  const recovered = new ToolExecutionStore({ persistence: recoveredPersistence });
  assert.deepEqual(recovered.fileReceipt('receipts_0', path), { kind: 'model_image', path: snapshot });
  recovered.fork('receipts_0', 'fork', new Set(['turn_1']));
  assert.deepEqual(recovered.fileReceipt('fork', path), { kind: 'model_image', path: snapshot });
  if (process.platform === 'win32') assert.deepEqual(recovered.fileReceipt('receipts_0', path.toUpperCase().replaceAll('\\', '/')), { kind: 'model_image', path: snapshot });
  recoveredPersistence.close();
});

test("rejects conflicting identities and duplicate Runtime workspace changes", () => {
  const store = new ToolExecutionStore({ now: () => NOW });
  store.record(toolCall(), identity(), outcome());
  assert.throws(
    () => store.record(toolCall(), identity(), outcome({ result: { value: "changed" } })),
    /different record/,
  );
  assert.throws(
    () => new ToolExecutionStore({ now: () => NOW }).record(
      toolCall(),
      identity(),
      outcome({ workspaceChanges: [workspaceChange(), workspaceChange()] }),
    ),
    /duplicate Workspace Change/,
  );
});

test("fails closed when a complete persisted Tool record is mutated", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  new ToolExecutionStore({ persistence, now: () => NOW }).record(
    toolCall(),
    identity(),
    outcome(),
  );
  persistence.close();
  const path = join(root, readdirSync(root)[0]);
  writeFileSync(path, readFileSync(path, "utf8").replace('"ok"', '"no"'));
  const reopened = new FileToolExecutionPersistence({ root });
  assert.throws(
    () => new ToolExecutionStore({ persistence: reopened }).listTurn("session_1", "turn_1"),
    ToolExecutionJournalCorruptionError,
  );
  reopened.close();
});

test("checks persisted Tool bytes before adding protocol defaults", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  const failed = outcome({
    kind: "failed",
    result: undefined,
    error: {
      kind: "tool",
      code: "fixture_failure",
      message: "fixture failed",
      details: {},
    },
  });
  new ToolExecutionStore({ persistence, now: () => NOW }).record(
    toolCall(),
    identity(),
    failed,
  );
  persistence.close();

  const path = join(root, readdirSync(root)[0]);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  delete persisted.record.error.kind;
  persisted.checksum = createHash("sha256")
    .update(JSON.stringify(persisted.record))
    .digest("hex");
  writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");

  const [recovered] = new FileToolExecutionPersistence({ root }).load("session_1");
  assert.equal(recovered.error.kind, "tool");
});

const NOW = "2026-08-29T00:00:00.000Z";

function identity() {
  return {
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    round: 1,
    ordinal: 0,
  };
}

function toolCall() {
  return {
    protocol: "bush.tool_call.v1",
    id: "call_1",
    name: "fixture_tool",
    argumentsText: "{}",
  };
}

function artifact() {
  return {
    artifact_id: "artifact_1",
    type: "image",
    path: "C:\\tmp\\image.png",
    media_type: "image/png",
    display: "inline",
    metadata: {},
  };
}

function workspaceChange() {
  return {
    change_id: "change_1",
    path: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    metadata: {},
  };
}

function outcome(overrides = {}) {
  const manifest = {
    protocol: "bush.tool.action_manifest.v1",
    manifest_id: "attempt:turn_1:1:call_1",
    effect_kind: "observation",
    operation: "fixture.read",
    risk: "low",
    owner: "fixture",
    dispatch_scope: "turn",
    mutating: false,
  };
  const base = {
    kind: "returned",
    actionManifest: manifest,
    result: { value: "ok", artifacts: [artifact()] },
    workspaceChanges: [workspaceChange()],
  };
  return { ...base, ...overrides };
}

test('200 Turns retain only two undo payloads in cache while old Tool facts remain readable', async () => {
  const journal = [];
  const persistence = { load: () => journal, append: record => journal.push(record) };
  const store = new ToolExecutionStore({ persistence, now: () => NOW });
  const change = { ...workspaceChange(), metadata: { beforeContentBase64: Buffer.from('before'.repeat(4096)).toString('base64'), diff: '+after\n'.repeat(1024) } };
  const result = outcome({ workspaceChanges: [change] });
  for (let turn = 1; turn <= 200; turn++) store.record(toolCall(), { ...identity(), turnId: `turn_${turn}` }, result);
  let retained = 0;
  for (const entry of await store.cacheEntries()) await entry.scan?.(json => {
    retained += JSON.parse(json).workspaceChanges.filter(item => 'beforeContentBase64' in item.metadata).length;
  });
  assert.equal(retained, 2);
  assert.equal(store.listTurnSummaries('session_1', 'turn_1')[0].workspaceChanges[0].detailAvailable, true);
  assert.deepEqual(store.get('session_1', 'turn_1', 'call_1').workspaceChanges[0], change);
  assert.deepEqual(store.listTurn('session_1', 'turn_1')[0].workspaceChanges[0], change);
  assert.deepEqual(store.record(toolCall(), identity(), result).workspaceChanges[0], change, 'replaying an evicted identity remains idempotent');
  assert.equal(journal.length, 200);
  assert.deepEqual(journal[0].workspaceChanges[0], change, 'canonical facts were not rewritten');
  const reopened = new ToolExecutionStore({ persistence });
  assert.deepEqual(reopened.get('session_1', 'turn_1', 'call_1').workspaceChanges[0], change);
});

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-tool-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
