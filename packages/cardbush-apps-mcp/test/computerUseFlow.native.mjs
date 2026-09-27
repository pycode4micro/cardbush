// Opt-in integration: all mutations belong to the disposable WPF fixture.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { computerUseMcpResult } from '../dist/plugins/computerUse.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';

if (process.platform !== 'win32') throw Error('Windows required');
const fixture = launchDesktopFixture();
const scope = `flow-${randomUUID()}`;
const config = defaultAppsRuntimeConfig().computerUse.config;
const call = input => executeComputerUse(input, config, undefined, scope);
const bind = (observed, input) => ({ hwnd: observed.window.hwnd, state_id: observed.state_id, ...input });
const element = (observed, id) => {
  const result = observed.accessibility?.elements.find(item => item.automation_id === id);
  assert.ok(result, `missing ${id}`); return result;
};
const center = element => ({ x: Math.round(element.bounds.x + element.bounds.width / 2), y: Math.round(element.bounds.y + element.bounds.height / 2) });
const checks = [];
const pass = name => { checks.push(name); console.log('PASS', name); };
try {
  const { hwnd } = await fixture.ready;
  let state = (await call({ action: 'observe', hwnd })).output;
  assert.equal(state.accessibility, undefined);
  assert.ok(state.state_id); assert.equal(state.actionable, true);
  pass('default observation supplies screenshot evidence and state without the UIA tree');

  state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  const first = await call(bind(state, { action: 'invoke', element_index: element(state, 'fixture-button').index, include_text: true }));
  assert.equal(first.output.execution, 'dispatched');
  assert.equal((await fixture.command('inspect')).count, 1);
  assert.ok(first.output.observation.state_id);
  assert.notEqual(first.output.observation.state_id, state.state_id);
  const mcp = await computerUseMcpResult(first, 'invoke');
  assert.equal(mcp.content.filter(item => item.type === 'image').length, 1);
  state = first.output.observation;
  pass('one semantic action returns the verified new application state and an MCP image');

  const clicked = await call(bind(state, { action: 'click', ...center(element(state, 'fixture-button')), include_text: true }));
  assert.equal(clicked.error, undefined);
  assert.equal(clicked.output.execution, 'dispatched');
  assert.equal(clicked.output.pointer_restored, true);
  assert.equal((await fixture.command('inspect')).count, 2);
  state = clicked.output.observation;
  pass('tagged pointer movement does not trigger human takeover');

  for (let cycle = 0; cycle < 3; cycle++) {
    await fixture.command('popupOnClick');
    const opened = await call(bind(state, { action: 'invoke', element_index: element(state, 'fixture-button').index, include_text: true }));
    if (opened.error) assert.equal(opened.error.code, 'window_changed');
    assert.ok(['dispatched', 'unknown'].includes(opened.output.execution));
    state = opened.output.observation;
    assert.equal(state.target_relation, 'owned_popup');
    assert.notEqual(state.window.hwnd, hwnd);
    assert.equal(state.window.owner_hwnd, hwnd);
    assert.ok(state.state_id); assert.equal(state.actionable, true);
    assert.equal(computerUsePresentation.isPaused(scope), false);
    const closed = await call(bind(state, { action: 'invoke', element_index: element(state, 'fixture-popup-close').index, include_text: true }));
    if (closed.error) assert.ok(['window_changed', 'window_unavailable'].includes(closed.error.code));
    state = closed.output.observation;
    assert.equal(state.window?.hwnd, hwnd, JSON.stringify(closed));
    assert.equal(state.target_relation, 'owner_window');
    assert.ok(state.state_id);
  }
  assert.equal((await fixture.command('inspect')).count, 5);
  pass('three untitled owned-popup cycles recover without consuming the human-takeover budget');

  await fixture.command('switchDuringTyping', { after: 2 });
  state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  const switched = await call(bind(state, { action: 'type', text: 'abcdefghijklmnopqrstuvwxyz' }));
  assert.equal(switched.error.code, 'window_changed');
  assert.equal(switched.error.execution, 'unknown');
  state = switched.output.observation;
  const actual = await fixture.command('inspect');
  assert.ok(actual.text.length >= 2 && actual.text.length < 26);
  assert.equal(actual.coverText, 'COVER MUST NOT RECEIVE INPUT');
  assert.equal(state.window.hwnd, hwnd);
  assert.equal(state.is_foreground, false);
  assert.equal(state.foreground_window.relation, 'unrelated');
  assert.equal(computerUsePresentation.isPaused(scope), false);
  const activated = await call(bind(state, { action: 'window', operation: 'activate', include_text: true }));
  state = activated.output.observation;
  assert.equal(state.actionable, true);
  pass('unowned same-process foreground interrupts partial input and never receives remaining text');

  state = (await call({ action: 'observe', hwnd, include_text: true, include_screenshot: false })).output;
  const textOnly = await call(bind(state, { action: 'set_value', value: 'text-only evidence',
    element_index: element(state, 'fixture-input').index, include_text: true, include_screenshot: false }));
  assert.equal(textOnly.paths.length, 0); assert.equal(textOnly.artifacts.length, 0);
  assert.equal(element(textOnly.output.observation, 'fixture-input').value, 'text-only evidence');
  state = textOnly.output.observation;
  pass('text-only observation retains state validation and returns actual UIA values');

  const root = await mkdtemp(join(tmpdir(), 'cardbush-post-capture-fault-'));
  const occupiedPath = join(root, 'file'); await writeFile(occupiedPath, 'fixture');
  const before = (await fixture.command('inspect')).count;
  const failedCapture = await executeComputerUse(bind(state, { action: 'invoke', element_index: element(state, 'fixture-button').index }),
    { ...config, screenshotDirectory: occupiedPath }, undefined, scope);
  assert.equal(failedCapture.output.execution, 'dispatched');
  assert.ok(failedCapture.output.observation.error);
  assert.equal(failedCapture.output.observation.state_id, undefined);
  assert.equal((await fixture.command('inspect')).count, before + 1);
  pass('capture failure preserves successful dispatch and never replays the action');

  state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  await fixture.command('stopControl');
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(call(bind(state, { action: 'invoke', element_index: element(state, 'fixture-button').index })),
    error => error.info?.code === 'user_stopped');
  await call({ action: 'finish' });
  await assert.rejects(call({ action: 'observe', hwnd }), error => error.info?.code === 'user_stopped');
  assert.equal((await fixture.command('inspect')).count, before + 1);
  pass('explicit stop remains latched after finish and blocks further observation/control in the turn');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await call({ action: 'finish' }).catch(() => undefined);
  computerUsePresentation.dispose(); fixture.close();
}
