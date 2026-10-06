import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installAppSessionPermissions } = require('../dist-electron/appSessionPermissions.js');

function fixture() {
  let check, request;
  const host = { getURL: () => 'file:///app/index.html', session: {
    setPermissionCheckHandler: handler => { check = handler; },
    setPermissionRequestHandler: handler => { request = handler; },
  } };
  installAppSessionPermissions({ isDestroyed: () => false, webContents: host });
  return { host, check, request: (contents, permission, details) => {
    const results = [];
    request(contents, permission, granted => results.push(granted), details);
    assert.equal(results.length, 1, 'permission request resolves exactly once');
    return results[0];
  } };
}

test('web content never delegates external app links to the OS', () => {
  const { host, check, request } = fixture();
  for (const contents of [host, { getURL: () => 'https://www.douyin.com/hot' }, null]) {
    for (const isMainFrame of [true, false]) {
      const details = { isMainFrame, requestingUrl: 'https://www.douyin.com/hot', externalURL: 'bytedance://probe' };
      assert.equal(check(contents, 'openExternal', 'https://www.douyin.com', details), false);
      assert.equal(request(contents, 'openExternal', details), false);
    }
  }
});

test('app microphone remains restricted to the trusted main frame', () => {
  const { host, check, request } = fixture();
  for (const [contents, isMainFrame, requestingUrl, mediaType, expected] of [
    [host, true, host.getURL(), 'audio', true],
    [host, false, host.getURL(), 'audio', false],
    [host, true, 'https://example.test/', 'audio', false],
    [{}, true, host.getURL(), 'audio', false],
    [null, true, host.getURL(), 'audio', false],
    [host, true, host.getURL(), 'video', false],
  ]) {
    const details = { isMainFrame, requestingUrl, mediaType, mediaTypes: [mediaType] };
    assert.equal(check(contents, 'media', '', details), expected);
    assert.equal(request(contents, 'media', details), expected);
  }
  assert.equal(request(host, 'media', { isMainFrame: true, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(check({}, 'fullscreen', '', {}), true, 'ordinary page fullscreen behavior is unchanged');
});
