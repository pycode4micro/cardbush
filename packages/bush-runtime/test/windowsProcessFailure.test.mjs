import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsProcessFailure } from '../dist/windowsProcessFailure.js';

test('explicit policy failures identify the executable without advising policy bypass', () => {
  for (const code of [4551, 1260]) {
    const result = windowsProcessFailure(code, 'C:\\Tools With Spaces\\worker.exe');
    assert.equal(result.code, 'process_application_control_blocked');
    assert.equal(result.blockedExecutable, 'C:\\Tools With Spaces\\worker.exe');
    assert.ok(result.message.includes(String(code)));
    assert.match(result.message, /发布者/);
    assert.doesNotMatch(result.message, /disable|exclusion|关闭安全|以管理员/);
  }
  assert.equal(windowsProcessFailure(577, 'plugin.dll').code, 'process_signature_rejected');
});

test('ordinary access and resource errors are not misclassified as application control', () => {
  for (const code of [undefined, 0, 2, 5, 8, 87, 193, 216]) assert.equal(windowsProcessFailure(code, 'worker.exe'), undefined);
});
