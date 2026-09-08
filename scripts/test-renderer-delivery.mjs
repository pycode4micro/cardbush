import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { sendToLiveRenderer } = createRequire(import.meta.url)('../dist-electron/rendererDelivery.js');

function fixture() {
  const state = { windowGone: false, contentsGone: false, crashed: false, frameGone: false, detached: false };
  const sent = [];
  const frame = { isDestroyed: () => state.frameGone, get detached() { return state.detached; },
    send: (...args) => sent.push(args) };
  const contents = { isDestroyed: () => state.contentsGone, isCrashed: () => state.crashed,
    get mainFrame() { return frame; } };
  const window = { isDestroyed: () => state.windowGone, get webContents() { return contents; } };
  return { state, sent, frame, contents, window };
}

test('notifications skip every disposed lifecycle without querying a dead window', () => {
  assert.equal(sendToLiveRenderer(null, 'capabilities:changed'), false);
  for (const key of ['windowGone', 'contentsGone', 'crashed', 'frameGone', 'detached']) {
    const f = fixture(); f.state[key] = true;
    if (key === 'windowGone') Object.defineProperty(f.window, 'webContents', { get() { throw Error('dead window accessed'); } });
    assert.equal(sendToLiveRenderer(f.window, 'capabilities:changed'), false, key);
    assert.deepEqual(f.sent, []);
  }
});

test('a navigation race never retargets a notification to the replacement document', () => {
  const f = fixture();
  f.frame.send = () => {
    f.state.detached = true;
    Object.defineProperty(f.contents, 'mainFrame', { get() { throw Error('replacement frame accessed'); } });
    throw Error('Render frame was disposed');
  };
  assert.equal(sendToLiveRenderer(f.window, 'capabilities:changed'), false);
});

test('live notifications deliver once and unrelated payload errors are not swallowed', () => {
  const f = fixture();
  assert.equal(sendToLiveRenderer(f.window, 'terminal:data', { id: 'fixture', data: 'hello' }), true);
  assert.deepEqual(f.sent, [['terminal:data', { id: 'fixture', data: 'hello' }]]);
  f.frame.send = () => { throw Error('could not be cloned'); };
  assert.throws(() => sendToLiveRenderer(f.window, 'terminal:data', () => {}), /could not be cloned/);
});
