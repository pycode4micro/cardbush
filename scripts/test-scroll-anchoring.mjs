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
delete globalThis.window;
console.log('Scroll anchoring passed: overlapping motion/disclosure, both release orders, rapid toggles and original styles.');
