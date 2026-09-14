import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const module = { exports: {} };
const compiled = ts.transpileModule(readFileSync('src/features/shortcuts/keyboardShortcuts.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', compiled)(module, module.exports);
const { matchesShortcut, bindingFromEvent, conflictingShortcut, bindingError, normalizeShortcutOverrides, shortcutBinding } = module.exports;
const key = (value, options = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...options });
assert.equal(matchesShortcut('sendMessage', key('Enter'), {}), true);
assert.equal(matchesShortcut('sendMessage', key('Enter', { ctrlKey: true }), {}), false, 'guidance must never enter the ordinary queue/send branch');
assert.equal(matchesShortcut('guideNow', key('Enter', { ctrlKey: true }), {}), true);
assert.equal(matchesShortcut('guideNow', key('Enter', { metaKey: true }), {}), true);
for (const flags of [{ shiftKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 }, { ctrlKey: true, repeat: true }]) {
  assert.equal(matchesShortcut('guideNow', key('Enter', flags), {}), false);
}
const custom = { guideNow: { key: 'u', ctrl: true, shift: true } };
assert.equal(matchesShortcut('guideNow', key('Enter', { ctrlKey: true }), custom), false);
assert.equal(matchesShortcut('guideNow', key('U', { ctrlKey: true, shiftKey: true }), custom), true);
assert.equal(matchesShortcut('guideNow', key('Enter', { ctrlKey: true }), { guideNow: null }), false);
assert.equal(conflictingShortcut('guideNow', { key: 'Enter', ctrl: true }, {}), undefined, 'message edits and guidance have different focused contexts');
assert.equal(conflictingShortcut('guideNow', { key: 't', ctrl: true }, {}).id, 'openBrowser');
assert.equal(conflictingShortcut('sendMessage', { key: 'Enter', ctrl: true }, {}).id, 'guideNow');
assert.equal(conflictingShortcut('imageReset', { key: 't', ctrl: true }, {}), undefined, 'modal image gestures do not invoke app shortcuts');
for (const event of [key('Control'), key('Dead'), key('Process')]) assert.equal(bindingFromEvent(event), null);
for (const [id, binding] of [['guideNow', { key: 'a' }], ['guideNow', { key: 'v', ctrl: true }], ['sendMessage', { key: 'Enter', shift: true }], ['openFiles', { key: 'F5' }]]) {
  assert.ok(bindingError(id, binding, 'en'));
}
assert.equal(matchesShortcut('imageZoomIn', key('+', { ctrlKey: true, shiftKey: true }), {}), true);
assert.equal(matchesShortcut('imageZoomIn', key('=', { ctrlKey: true }), {}), true);
assert.equal(matchesShortcut('imageZoomOut', key('-', { ctrlKey: true, code: 'NumpadSubtract' }), {}), true);
assert.deepEqual(normalizeShortcutOverrides(null), {});
assert.deepEqual(normalizeShortcutOverrides({ unknown: { key: 't', ctrl: true }, openFiles: 'broken' }), {});
assert.deepEqual(normalizeShortcutOverrides({ guideNow: { key: 'Enter', ctrl: true }, openFiles: null }), { openFiles: null });
assert.deepEqual(normalizeShortcutOverrides({ guideNow: { key: 't', ctrl: true } }), { guideNow: null });
assert.deepEqual(shortcutBinding('guideNow', {}), { key: 'Enter', ctrl: true });
console.log('Keyboard shortcuts passed: exact modifiers, guidance/send separation, IME/repeat guards, scoped conflicts, disable/reset and malformed settings.');
