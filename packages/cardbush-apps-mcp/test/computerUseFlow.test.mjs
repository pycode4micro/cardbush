import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { computerUseMcpResult } from '../dist/plugins/computerUse.js';
import { ComputerUseFailure, computerUseFailure } from '../dist/plugins/computerUseErrors.js';
import { computerUseNoticeFailure, computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { ComputerUseSafetyGuard, executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';
import { createCardbushAppsServer } from '../dist/index.js';

test('control notices distinguish real input, explicit stop, foreground changes and expired workers', () => {
  for (const [notice, code] of [
    [{ kind: 'paused', reason: 'mouse' }, 'user_takeover'],
    [{ kind: 'paused', reason: 'keyboard' }, 'user_takeover'],
    [{ kind: 'context_changed', reason: 'foreground_changed', target_hwnd: 12, foreground_hwnd: 34 }, 'window_changed'],
    [{ kind: 'stopped', reason: 'escape' }, 'user_stopped'],
    [{ kind: 'stopped', reason: 'button' }, 'user_stopped'],
    [{ kind: 'stopped', reason: 'window_closed' }, 'window_unavailable'],
    [{ kind: 'stopped', reason: 'idle_timeout' }, 'control_unavailable'],
    [{ kind: 'stopped', reason: 'presentation_closed' }, 'control_unavailable'],
  ]) {
    const error = computerUseNoticeFailure(notice);
    assert.equal(error.info.code, code);
    assert.equal(error.info.details.source, notice.reason);
    const running = computerUseFailure(error, 'unknown');
    assert.equal(running.info.execution, 'unknown');
    assert.deepEqual(running.info.details, error.info.details);
  }
});

test('errors retain dispatch uncertainty and bounded native diagnostics', () => {
  assert.equal(computerUseFailure({ killed: true }, 'unknown').info.code, 'timeout');
  const before = computerUseFailure(new Error('The desktop state_id expired before it was used.'));
  assert.equal(before.info.code, 'stale_state');
  assert.equal(before.info.execution, 'not_dispatched');
  const dispatched = new ComputerUseFailure('observation_failed', 'Capture unavailable', 'dispatched');
  assert.equal(computerUseFailure(dispatched).info.execution, 'dispatched');
  assert.match(dispatched.info.recovery, /do not repeat/i);
});

test('state and guard rejections retain presentation without ending the session', { skip: process.platform !== 'win32' }, async t => {
  const events=[];
  for (const method of ['hold','finish','restore']) t.mock.method(computerUsePresentation,method,async()=>{events.push(method);});
  const call=()=>executeComputerUse({action:'click',hwnd:1},defaultAppsRuntimeConfig().computerUse.config,undefined,'retained-preflight');
  await assert.rejects(call(),error=>error.info?.code==='stale_state');
  await assert.rejects(call(),error=>error.info?.code==='stale_state');
  await assert.rejects(call(),error=>error.info?.code==='invalid_action' && error.info.details.reason==='repeated_preflight');
  assert.deepEqual(events,['hold','restore','hold','restore','hold']);
});

test('cancellation revokes presentation before clearing orphaned capture masks', { skip: process.platform !== 'win32' }, async t => {
  const events=[];
  const controller=new AbortController();
  t.mock.method(computerUsePresentation,'hold',async()=>{events.push('hold');controller.abort();});
  for (const method of ['finish','restore']) t.mock.method(computerUsePresentation,method,async()=>{events.push(method);});
  // Fail before native dispatch, then cancel while the failure is settling.
  // No desktop worker or real input is started in this lifecycle test.
  await assert.rejects(executeComputerUse({action:'click',hwnd:1},defaultAppsRuntimeConfig().computerUse.config,controller.signal,'cancelled-capture-cleanup'));
  assert.deepEqual(events,['hold','finish','restore']);
});

test('observation options cannot evade the repeated-action guard', () => {
  const guard = new ComputerUseSafetyGuard();
  const input = { action: 'click', hwnd: 1, x: 2, y: 3 };
  guard.recordAction('scope', { ...input, include_text: true, settle_ms: 100 });
  guard.recordAction('scope', { ...input, include_text: false, include_screenshot: false, observe_after: false, max_elements: 300 });
  assert.throws(() => guard.begin('scope', { ...input, state_id: 'new', settle_ms: 500 }), /repeated action/);
});

test('observation schema permits text-only evidence but never an empty observation', () => {
  const schema = createCardbushAppsServer()._registeredTools.computer_use.inputSchema;
  assert.equal(schema.safeParse({ action: 'observe', hwnd: 1, include_text: true, include_screenshot: false }).success, true);
  assert.equal(schema.safeParse({ action: 'observe', hwnd: 1, include_screenshot: false }).success, false);
  assert.equal(schema.safeParse({ action: 'observe', hwnd: 1, settle_ms: 1001 }).success, false);
  assert.equal(schema.safeParse({ action: 'observe', hwnd: 1, include_text: false }).success, true);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64');
test('observations include standard MCP image bytes and keep UI artifacts without double model injection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-image-delivery-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-image-delivery-'));
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'shot.png'); await writeFile(path, png);
  const native = { output: { state_id: 'new-state', window: { hwnd: 12 } }, paths: [path],
    artifacts: [{ artifact_id: 'a', type: 'image', path, media_type: 'image/png', display: 'inline', metadata: { model_input: true } }] };
  const original = structuredClone(native);
  const result = await computerUseMcpResult(native, 'observe');
  assert.equal(result.content[1].type, 'image');
  assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), png);
  assert.equal(result.content[1]._meta['codex/imageDetail'], 'original');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.artifacts[0].metadata.model_input, false);
  assert.deepEqual(native, original);

  const missing = await computerUseMcpResult({ ...native, output: { execution: 'dispatched' },
    artifacts: [{ ...native.artifacts[0], path: join(root, 'missing.png') }] }, 'click');
  assert.equal(missing.structuredContent.output.execution, 'dispatched');
  assert.equal(missing.structuredContent.image_delivery.status, 'unavailable');
  assert.match(missing.structuredContent.image_delivery.next_step, /without repeating input/);
  assert.equal(missing.content.filter(item => item.type === 'image').length, 0);
});

test('failed partial input can carry its recovery screenshot without losing error status', async () => {
  const error = computerUseFailure(computerUseNoticeFailure({ kind: 'context_changed', reason: 'foreground_changed' }), 'unknown').info;
  const result = await computerUseMcpResult({ output: { observation: { state_id: 'popup-state', window: { hwnd: 2 } } },
    paths: [], artifacts: [], error }, 'click');
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.execution, 'unknown');
  assert.equal(result.structuredContent.error.code, 'window_changed');
  assert.equal(result.structuredContent.output.observation.state_id, 'popup-state');
});
