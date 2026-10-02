import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installApplicationInstance } from '../dist-electron/applicationInstance.js';

test('secondary startup exits before bootstrap; early relaunches restore only after the window is ready', () => {
  const app = new EventEmitter(); let restores = 0, exitCode;
  app.requestSingleInstanceLock = () => true; app.exit = code => { exitCode = code; };
  const instance = installApplicationInstance(app, () => restores++);
  app.emit('second-instance'); app.emit('second-instance');
  assert.equal(restores, 0); instance.windowReady(); assert.equal(restores, 1);
  app.emit('second-instance'); assert.equal(restores, 2); assert.equal(exitCode, undefined);
  const secondary = new EventEmitter(); secondary.requestSingleInstanceLock = () => false; secondary.exit = app.exit;
  assert.equal(installApplicationInstance(secondary, () => assert.fail('Secondary must not restore')).primary, false);
  assert.equal(exitCode, 0); assert.equal(secondary.listenerCount('second-instance'), 0);
});

test('real Electron relaunch wakes the existing hidden window in the same profile', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-instance-test-'));
  const children = [], outcomes = [];
  t.after(async () => {
    fs.writeFileSync(path.join(root, 'quit'), '');
    await Promise.race([Promise.all(outcomes), new Promise(resolve => setTimeout(resolve, 3000))]);
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(outcomes);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixture = path.join(root, 'fixture.cjs');
  fs.writeFileSync(fixture, `
    const { app, BrowserWindow } = require('electron');
    const fs = require('node:fs'), path = require('node:path');
    const root = __dirname;
    app.setPath('userData', path.join(root, 'profile'));
    const { installApplicationInstance } = require(${JSON.stringify(path.resolve('dist-electron/applicationInstance.js'))});
    let window;
    const instance = installApplicationInstance(app, () => {
      window.show();
      const shown = setInterval(() => {
        if (!window.isVisible()) return;
        clearInterval(shown);
        fs.writeFileSync(path.join(root, 'restored.json'), JSON.stringify({ pid: process.pid, visible: true }));
        window.hide();
      }, 20);
    });
    if (instance.primary) app.whenReady().then(async () => {
      window = new BrowserWindow({ show: true, width: 200, height: 150 });
      await window.loadURL('data:text/html,<title>CardBush instance regression</title>');
      window.hide();
      instance.windowReady();
      fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ pid: process.pid, visible: window.isVisible() }));
      setInterval(() => { if (fs.existsSync(path.join(root, 'quit'))) app.exit(0); }, 50);
    });
  `);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  function launch() {
    const child = spawn(electron, [fixture], { env, windowsHide: true, stdio: 'ignore' }); children.push(child);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    outcomes.push(done); return done;
  }
  async function read(name) {
    const file = path.join(root, name);
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`Missing fixture event: ${name}`);
  }
  const first = launch(); const ready = await read('ready.json'); assert.equal(ready.visible, false);
  const second = launch(); const restored = await read('restored.json');
  assert.equal(restored.pid, ready.pid); assert.equal(restored.visible, true);
  assert.equal(await second, 0); assert.equal(children[0].exitCode, null);
  fs.writeFileSync(path.join(root, 'quit'), ''); assert.equal(await first, 0);
});
