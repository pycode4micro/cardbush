import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('preview pressure relief is app-wide, throttled, and never selects shared conversation/browser processes', () => {
  let now = 100_000, timer, schedules = 0, clears = 0, reads = 0;
  class Contents extends EventEmitter {
    constructor(pid, url, type = 'webview') { super(); this.pid = pid; this.url = url; this.type = type; this.crashes = 0; }
    isDestroyed() { return false; }
    getOSProcessId() { return this.pid; }
    getURL() { return this.url; }
    getType() { return this.type; }
    forcefullyCrashRenderer() { this.crashes++; }
  }
  const firstOwner = new Contents(1, 'file:///app.html', 'window'), secondOwner = new Contents(2, 'file:///shadow.html', 'window');
  const first = new Contents(10, 'file:///report.html'), second = new Contents(11, 'cardbush-file://office-preview/?path=report.xlsx');
  let contents = [firstOwner, secondOwner, first, second];
  let measures = [{ pid: 1, memory: { privateBytes: 1000 * 1024 } }, { pid: 10, memory: { privateBytes: 300 * 1024 } }, { pid: 11, memory: { privateBytes: 200 * 1024 } }];
  const exports = {};
  vm.runInNewContext(readFileSync('dist-electron/previewResourceProtection.js', 'utf8'), {
    exports, require(name) {
      if (name === 'electron') return { app: { getAppMetrics: () => { reads++; return measures; } }, webContents: { getAllWebContents: () => contents } };
      if (name === 'node:os') return { freemem: () => 8 * 1024 ** 3, totalmem: () => 16 * 1024 ** 3 };
      throw new Error(name);
    }, Date: class extends Date { static now() { return now; } }, URL,
    setInterval(callback) { timer = callback; schedules++; return { unref() {} }; }, clearInterval() { clears++; },
  });
  exports.installPreviewResourceProtection(firstOwner); exports.installPreviewResourceProtection(secondOwner);
  firstOwner.emit('did-attach-webview', {}, first); secondOwner.emit('did-attach-webview', {}, second);
  assert.equal(schedules, 1, 'one monitor across main and Shadow');
  assert.equal(exports.applicationMemoryBytes(), 1500 * 1024 ** 2);
  exports.applicationMemoryBytes(); assert.equal(reads, 1, 'metrics are cached between startup requests');
  assert.equal(exports.relievePreviewForMemoryPressure(), true); assert.equal(first.crashes, 1);
  assert.equal(exports.relievePreviewForMemoryPressure(), true); assert.equal(first.crashes, 1, 'cooldown prevents cascaded crashes');
  now += 7_000;
  measures = [{ pid: 11, memory: { privateBytes: 1200 * 1024 } }];
  contents.push(new Contents(11, 'https://example.com/'));
  timer(); assert.equal(second.crashes, 0, 'a shared remote tab is protected');
  contents = contents.filter(item => !item.url.startsWith('https:'));
  timer(); assert.equal(second.crashes, 1, 'an oversized isolated preview is relieved even without system pressure');
  assert.equal(firstOwner.crashes, 0); assert.equal(secondOwner.crashes, 0);
  firstOwner.emit('destroyed'); assert.equal(clears, 0, 'closing main does not stop Shadow monitoring');
  secondOwner.emit('destroyed'); assert.equal(clears, 1);
});
