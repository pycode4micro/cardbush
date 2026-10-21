import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const modules = new Map();
function load(file) {
  const resolved = path.resolve(file);
  if (modules.has(resolved)) return modules.get(resolved);
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(resolved, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = name => name === 'react-dom' ? { flushSync: update => update() }
    : name.endsWith('/responseSpacer') ? { updateResponseSpacer() {} }
      : load(path.resolve(path.dirname(resolved), name + '.ts'));
  new Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  modules.set(resolved, module.exports);
  return module.exports;
}
const { createChatScrollMotion } = load('src/features/chat/chatScrollMotion.ts');
const { preserveScrollPositionForToggle } = load('src/features/preserveScrollPosition.ts');

for (const initial of ['', 'auto', 'none']) {
  for (const toggleFirst of [false, true]) {
    for (const toggleFinishesFirst of [false, true]) {
      const frames = new Map();
      let nextFrame = 0;
      globalThis.window = {
        requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
        cancelAnimationFrame(id) { frames.delete(id); },
        matchMedia: () => ({ matches: false }),
      };
      const scroller = {
        style: { overflowAnchor: initial }, dataset: {}, isConnected: true,
        scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
        getBoundingClientRect: () => ({ top: 0 }), querySelector: () => null,
        scrollTo({ top }) { this.scrollTop = top; },
      };
      const element = {
        isConnected: true, querySelector: () => null,
        closest: selector => selector === '.message-list' ? scroller : null,
        getBoundingClientRect: () => ({ top: 20 }),
      };
      const motion = createChatScrollMotion();
      let toggleFrame;
      const toggle = () => {
        preserveScrollPositionForToggle(element, () => {});
        toggleFrame = nextFrame;
        // Several toggles in the same paint retain just one pending cleanup.
        preserveScrollPositionForToggle(element, () => {});
        assert.equal(frames.has(toggleFrame), false);
        toggleFrame = nextFrame;
      };
      const move = () => motion.move(scroller, 100, 'jump');
      if (toggleFirst) { toggle(); move(); } else { move(); toggle(); }
      assert.equal(scroller.style.overflowAnchor, 'none');
      const finishToggle = () => { frames.get(toggleFrame)(); frames.delete(toggleFrame); };
      if (toggleFinishesFirst) {
        finishToggle();
        assert.equal(scroller.style.overflowAnchor, 'none', 'active motion retains its protection');
        motion.cancel();
      } else {
        motion.cancel();
        assert.equal(scroller.style.overflowAnchor, 'none', 'pending disclosure retains its protection');
        finishToggle();
      }
      assert.equal(scroller.style.overflowAnchor, initial, 'all owners release to the original anchoring state');
      assert.deepEqual(scroller.dataset, {});
      assert.equal(frames.size, 0);
      motion.cancel();
      assert.equal(scroller.style.overflowAnchor, initial, 'duplicate cleanup is harmless');
    }
  }
}
// Only explicit navigation animates; its destination can change mid-flight.
{
  const frames = new Map();
  let id = 0;
  globalThis.window = {
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    matchMedia: () => ({ matches: false }),
  };
  const scroller = { style: { overflowAnchor: 'auto' }, dataset: {}, isConnected: true,
    scrollTop: 500, scrollHeight: 3000, clientHeight: 500,
    scrollTo({ top }) { this.scrollTop = Math.round(top); } };
  const motion = createChatScrollMotion();
  let tail = 700, now = performance.now();
  const tick = delay => {
    now += delay;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(now));
  };
  motion.move(scroller, () => tail, 'jump');
  tick(50);
  assert.ok(scroller.scrollTop > 500 && scroller.scrollTop < 700, 'explicit jumps animate');
  tail = 760;
  for (let n = 0; frames.size && n < 80; n++) tick(16);
  assert.equal(scroller.scrollTop, tail, 'retarget to the settled height');
  assert.equal(frames.size, 0, 'integer scrollTop does not leave an endless animation');
  assert.equal(scroller.style.overflowAnchor, 'auto');
  const top = scroller.scrollTop;
  tail += 400;
  motion.move(scroller, () => tail, 'submission');
  motion.cancel();
  tick(500);
  assert.equal(scroller.scrollTop, top, 'manual reading cancels all pending follow frames');
  assert.equal(frames.size, 0);
}
const { updateResponseSpacer, reconcileResponseLayout, releaseResponseSpacer, captureResponseSpacer, restoreResponseSpacer } = load('src/features/chat/responseSpacer.ts');
{
  let contentHeight = 100, currentTop = 300, writes = 0;
  const spacer = { style: { height: '0px' }, dataset: {},
    getBoundingClientRect: () => ({ top: 500 - currentTop + contentHeight }) };
  const scroller = { clientHeight: 700, style: { getPropertyValue: () => '', setProperty() {} },
    querySelectorAll: () => [],
    get scrollHeight() { return 500 + contentHeight + parseFloat(spacer.style.height) + 168; },
    get scrollTop() { return Math.min(currentTop, Math.max(0, this.scrollHeight - this.clientHeight)); },
    scrollTo({ top }) { writes++; currentTop = top; },
    getBoundingClientRect: () => ({ top: 0, bottom: 700 }),
    querySelector: selector => selector === '.assistant-response-spacer' ? spacer
      : selector === '.message-list-footer' ? { getBoundingClientRect: () => ({ height: 168 }) }
        : { getBoundingClientRect: () => ({ top: 500 - currentTop, height: 40 }) },
  };
  const tail = { isConnected: true, getBoundingClientRect: () => ({ bottom: 500 - scroller.scrollTop + contentHeight }) };
  updateResponseSpacer(scroller, 'user');
  const initialHeight = scroller.scrollHeight, initialSpace = parseFloat(spacer.style.height);
  const layout = (follow = true, navigationActive = false) =>
    reconcileResponseLayout(scroller, { anchorKey: 'user', follow, navigationActive });
  contentHeight += 40;
  layout();
  assert.equal(scroller.scrollHeight, initialHeight, 'new content consumes reserve without changing total height');
  assert.equal(parseFloat(spacer.style.height), initialSpace - 40);
  assert.equal(writes, 0, 'no scroll is needed while new content fits');
  const savedSpace = captureResponseSpacer(scroller);
  updateResponseSpacer(scroller, '');
  contentHeight += 20;
  restoreResponseSpacer(scroller, 'user', savedSpace);
  assert.equal(parseFloat(spacer.style.height), initialSpace - 60, 'background output spends the saved reserve before viewport restoration');
  assert.equal(scroller.scrollHeight, initialHeight, 'session restoration retains the existing footprint');
  contentHeight += 600;
  layout();
  assert.ok(tail.getBoundingClientRect().bottom <= 542, 'overflow is visible before returning from layout');
  assert.equal(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight, 'spent reserve follows the real bottom including footer clearance');
  assert.equal(writes, 1, 'one synchronous position correction');
  layout();
  assert.equal(writes, 1, 'duplicate measurements are idempotent');
  contentHeight -= 40;
  layout();
  assert.equal(parseFloat(spacer.style.height), 0, 'shrinking content must not recreate spent reserve');
  const spentSpace = captureResponseSpacer(scroller);
  updateResponseSpacer(scroller, '');
  contentHeight -= 600;
  restoreResponseSpacer(scroller, 'user', spentSpace);
  assert.equal(parseFloat(spacer.style.height), 0, 'session restoration cannot refill an exhausted reserve');
  contentHeight += 600;
  currentTop = 250;
  contentHeight += 100;
  layout(false);
  assert.equal(scroller.scrollTop, 250, 'manual reading remains stationary');
  layout(true, true);
  assert.equal(scroller.scrollTop, 250, 'active navigation owns the viewport');
  layout();
  assert.ok(scroller.scrollTop > 250, 'navigation completion can synchronously catch up');
  contentHeight = 100;
  updateResponseSpacer(scroller, 'next-user');
  currentTop = scroller.scrollHeight - scroller.clientHeight;
  const beforeRelease = scroller.scrollTop;
  releaseResponseSpacer(scroller);
  assert.equal(scroller.scrollTop, beforeRelease, 'retiring visible space cannot clamp the reader upward');
  currentTop = 0;
  assert.equal(releaseResponseSpacer(scroller), true, 'offscreen space can be retired fully');
}

for (const scale of [0.8, 1, 1.25]) {
  let contentHeight = 100, inset = 168, top = 300;
  const spacer = { style: { height: '0px' }, dataset: {},
    getBoundingClientRect: () => ({ top: (500 - top + contentHeight) * scale }) };
  const scroller = { clientHeight: 700, offsetHeight: 700,
    style: { getPropertyValue: () => '', setProperty() {} }, querySelectorAll: () => [],
    get scrollHeight() { return 500 + contentHeight + parseFloat(spacer.style.height) + inset; },
    get scrollTop() { return Math.min(top, Math.max(0, this.scrollHeight - this.clientHeight)); },
    scrollTo({ top: next }) { top = next; },
    getBoundingClientRect: () => ({ top: 0, bottom: 700 * scale, height: 700 * scale }),
    querySelector: selector => selector === '.assistant-response-spacer' ? spacer
      : selector === '.message-list-footer' ? { getBoundingClientRect: () => ({ height: inset * scale }) }
        : { getBoundingClientRect: () => ({ top: (500 - top) * scale, height: 40 * scale }) },
  };
  const layout = () => reconcileResponseLayout(scroller, { anchorKey: 'user', follow: true, navigationActive: false });
  updateResponseSpacer(scroller, 'user');
  const reserved = parseFloat(spacer.style.height);
  contentHeight += 40; layout();
  assert.ok(Math.abs(parseFloat(spacer.style.height) - (reserved - 40)) <= 1, 'reserve consumption uses layout pixels at zoom ' + scale);
  contentHeight = 1000;
  for (let i = 0; i < 50; i++) {
    contentHeight += i % 4 ? 35 : -60;
    inset = i % 2 ? 168 : 208;
    layout();
    assert.equal(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight, 'no accumulated gap across content/footer changes at zoom ' + scale);
  }
}
delete globalThis.window;
console.log('Scroll anchoring passed: navigation ownership, atomic reserve consumption, synchronous follow and manual reading.');
