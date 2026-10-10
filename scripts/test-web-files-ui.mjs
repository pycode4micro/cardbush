import assert from 'node:assert/strict';
import test from 'node:test';
import { personalFilePath } from '../web/personalFiles.ts';

test('personal image references include runtime paths and model-authored double slashes', () => {
  const path = '/data/workspaces/generated/result.png';
  for (const source of [path, '/' + path, 'file://' + path, 'file://localhost' + path]) assert.equal(personalFilePath(source), path);
  assert.equal(personalFilePath('/data/workspaces/uploads/%E5%9B%BE%20%E7%89%87.png'), '/data/workspaces/uploads/图 片.png');
});
test('web image adapter rejects external locations, secrets and path traversal', () => {
  for (const source of ['https://example.com/image.png', '//example.com/data/workspaces/image.png', 'file://example.com/data/workspaces/image.png', '/data/config/web-policy.json', '/data/workspaces/../config/key', '/data/workspaces/%2e%2e/config/key', '/data/workspaces/x%00.png', 'data:image/png;base64,x']) assert.equal(personalFilePath(source), null, source);
});
