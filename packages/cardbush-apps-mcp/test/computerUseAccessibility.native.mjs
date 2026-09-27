// Opt-in desktop regression. Only the disposable fixture receives input.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';

const fixture = launchDesktopFixture();
const config = defaultAppsRuntimeConfig().computerUse.config;
let scope = `uia-query-${randomUUID()}`;
const call = input => executeComputerUse(input, config, undefined, scope);
const bind = (state, input) => ({ ...input, hwnd: state.window.hwnd, state_id: state.state_id });
const find = (state, id) => state.accessibility?.elements.find(item => item.automation_id === id);
const checks = [];
const pass = name => { checks.push(name); console.log('PASS', name); };
try {
  const { hwnd } = await fixture.ready;
  const { popup } = await fixture.command('fileDialog');
  const base = { action: 'observe', hwnd: popup, include_text: true, include_screenshot: false, max_elements: 20 };
  let state = (await call(base)).output;
  assert.ok(find(state, 'fixture-file-name'), 'late file-name Edit is prioritized before 150 file entries');
  assert.ok(find(state, 'fixture-file-open'), 'late Open button is prioritized');
  assert.ok(state.accessibility.total_elements > 150);
  assert.equal(state.accessibility.truncated, true);
  assert.ok(state.accessibility.next_offset > 0);
  pass('default UIA prioritizes file-name and Open controls past a crowded file list');

  const filename = (await call({ ...base, element_query: { name: '文件名', control_type: 'edit' } })).output;
  assert.equal(filename.accessibility.elements.length, 1);
  assert.equal(find(filename, 'fixture-file-name').value, '');
  const changed = await call(bind(filename, { action: 'set_value', element_index: find(filename, 'fixture-file-name').index,
    value: 'design-report.pdf', include_text: true, include_screenshot: false, element_query: { automation_id: 'fixture-file-name' } }));
  assert.equal((await fixture.command('inspect')).fileName, 'design-report.pdf');
  assert.equal(find(changed.output.observation, 'fixture-file-name').value, 'design-report.pdf');
  pass('directed name/type/ID queries retain exact runtime identity for real edits');

  const query = { name: 'Reference file' };
  state = (await call({ ...base, max_elements: 300, element_query: query })).output;
  assert.equal(state.accessibility.matched_elements, 150);
  assert.ok(state.accessibility.returned_elements < 150, 'model character budget is exercised');
  const collected = [...state.accessibility.elements];
  const firstState = state;
  while (state.accessibility.next_offset != null) {
    const offset = state.accessibility.next_offset;
    state = (await call({ ...base, max_elements: 300, element_query: query, element_offset: offset })).output;
    assert.equal(state.accessibility.offset, offset);
    assert.notEqual(state.state_id, firstState.state_id);
    collected.push(...state.accessibility.elements);
  }
  assert.equal(collected.length, 150);
  assert.equal(new Set(collected.map(item => item.index)).size, 150);
  assert.deepEqual(new Set(collected.map(item => item.automation_id)), new Set(Array.from({ length: 150 }, (_, i) => `file-row-${i}`)));
  await assert.rejects(call(bind(firstState, { action: 'click', x: 20, y: 20 })), error => error.info?.code === 'stale_state');
  pass('pagination traverses the character limit without skipping controls and invalidates old states');
  await call({ action: 'finish' });

  // A separate turn checks the original focus/type/Enter failure, with no UIA
  // tree returned to the model. Verify actual fixture text, not an input ACK.
  scope = `preparation-${randomUUID()}`;
  await fixture.command('closePopup');
  await fixture.command('activate');
  await fixture.command('reset');
  state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  const input = find(state, 'fixture-input');
  state = (await call(bind(state, { action: 'click', x: input.bounds.x + 20, y: input.bounds.y + 20 }))).output.observation;
  state = (await call(bind(state, { action: 'type', text: '文件传输助手' }))).output.observation;
  assert.equal(state.accessibility, undefined);
  state = (await call(bind(state, { action: 'key', keys: ['enter'] }))).output.observation;
  assert.match((await fixture.command('inspect')).text, /^文件传输助手\r?\n$/);
  assert.ok(state.state_id);
  pass('focus → Unicode typing → Enter completes with the normal automatic observation path');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await call({ action: 'finish' }).catch(() => undefined);
  computerUsePresentation.dispose(); fixture.close();
}
