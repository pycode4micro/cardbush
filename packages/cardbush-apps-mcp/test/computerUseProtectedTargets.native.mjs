import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';

const fixture = launchDesktopFixture();
const config = defaultAppsRuntimeConfig().computerUse.config;
const scope = randomUUID();
const previousDesktopPid = process.env.CARDBUSH_DESKTOP_PROCESS_ID;
const call = input => executeComputerUse(input, config, undefined, scope);
const blocked = input => assert.rejects(call(input), error =>
  error.info?.code === 'cardbush_target_blocked' && error.info.execution === 'not_dispatched');
try {
  const { hwnd } = await fixture.ready;
  // A title containing CardBush alone does not make an unrelated process
  // protected. Bind it first to exercise the native check on an existing state.
  const before = await call({ action: 'observe', hwnd, include_text: true, include_screenshot: false });
  assert.ok(before.output.state_id);
  process.env.CARDBUSH_DESKTOP_PROCESS_ID = String(fixture.child.pid);
  await blocked({ action: 'window', operation: 'minimize', hwnd, state_id: before.output.state_id });
  assert.equal((await fixture.command('inspect')).windowState, 'Normal');
  delete process.env.CARDBUSH_DESKTOP_PROCESS_ID;
  const inputState = (await call({ action: 'observe', hwnd, include_text: true, include_screenshot: false })).output;
  const button = inputState.accessibility.elements.find(element => element.automation_id === 'fixture-button');
  assert.ok(button);
  process.env.CARDBUSH_DESKTOP_PROCESS_ID = String(fixture.child.pid);
  await blocked({ action: 'invoke', hwnd, state_id: inputState.state_id, element_index: button.index });
  assert.equal((await fixture.command('inspect')).count, 0);
  await blocked({ action: 'observe', hwnd, include_text: true, include_screenshot: false });
  await blocked({ action: 'screenshot', hwnd });
  await blocked({ action: 'observe', title_pattern: 'CardBush isolated adversarial fixture', include_screenshot: false });
  const discovery = await call({ action: 'observe' });
  assert.ok(discovery.output.windows.every(window => window.process_id !== fixture.child.pid));
  for (const app of ['CardBush', 'CardBush.exe', 'cardbush-dev-012345abcdef.exe', 'com.cardbush.desktop']) {
    await blocked({ action: 'open_app', app });
  }
  delete process.env.CARDBUSH_DESKTOP_PROCESS_ID;
  const available = await call({ action: 'observe', hwnd, include_text: true, include_screenshot: false });
  assert.ok(available.output.state_id, 'the same turn can continue in an unrelated window');
  console.log('CardBush protection passed: existing window action, direct observation, screenshot, discovery, launch, and unrelated windows.');
} finally {
  if (previousDesktopPid === undefined) delete process.env.CARDBUSH_DESKTOP_PROCESS_ID;
  else process.env.CARDBUSH_DESKTOP_PROCESS_ID = previousDesktopPid;
  await call({ action: 'finish' }).catch(() => undefined);
  computerUsePresentation.dispose();
  fixture.close();
}
