import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsShellIconPath } from '../dist-electron/windowsAppIdentity.js';

test('packaged Shell identity uses the branded executable even when Electron can read ASAR icons', () => {
  const executablePath = 'C:\\Program Files\\应用 space\\CardBush.exe';
  assert.equal(windowsShellIconPath({ packaged: true, executablePath, exists: () => true,
    candidates: ['C:\\Program Files\\应用 space\\resources\\app.asar\\assets\\cardbush.ico'] }), executablePath);
});

test('unbranded Electron uses the real ICO and rejects ASAR paths accepted by the virtual filesystem', () => {
  const icon = 'C:/workspace/assets/cardbush.ico';
  assert.equal(windowsShellIconPath({ packaged: false, executablePath: 'C:/workspace/cardbush-dev.exe',
    candidates: ['C:/workspace/resources/app.asar/assets/cardbush.ico', icon], exists: () => true }), icon);
});

test('a rebranded development build gives Explorer a new icon location', () => {
  const candidates = ['C:/workspace/assets/cardbush.ico'];
  for (const identity of ['e11eb10a3260', '74f03e8dc8b2']) {
    const executablePath = 'C:\\workspace\\cardbush-dev-' + identity + '.exe';
    assert.equal(windowsShellIconPath({ packaged: false, executablePath, candidates, exists: () => true }), executablePath);
  }
});

test('native unpacked resources and a missing icon have valid fallbacks', () => {
  const executablePath = 'C:/CardBush.exe';
  const unpacked = 'C:/resources/app.asar.unpacked/assets/cardbush.ico';
  assert.equal(windowsShellIconPath({ packaged: false, executablePath, candidates: [unpacked], exists: () => true }), unpacked);
  assert.equal(windowsShellIconPath({ packaged: false, executablePath, candidates: ['missing.ico'], exists: p => p === executablePath }), executablePath);
  assert.equal(windowsShellIconPath({ packaged: true, executablePath, candidates: [], exists: () => false }), undefined);
});
