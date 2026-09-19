const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});

(async () => {
  const root = process.env.CARDBUSH_CAPTURE_TEST_ROOT;
  assert.ok(root, 'runner must provide an isolated test profile');
  app.setPath('userData', path.join(root, 'profile'));
  let window;
  try {
    await app.whenReady();
    const { createCardbushChromeServer } = await import('../packages/cardbush-chrome-mcp/dist/index.js');
    const { RuntimeToolLoop, ToolRegistry, ToolExecutionStore, InMemoryRuntimeEventLog, ModelImageStore } = await import('@cardbush/bush-runtime');
    window = new BrowserWindow({ show: false, width: 1000, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    const page = window.webContents;
    await page.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
      <style>body{margin:0;background:white;font:20px Arial;color:#222}h1{margin:0;height:60px}#chart{display:block;width:100%;height:240px}canvas{width:200px;height:100px}.long{height:2300px;background:linear-gradient(white,#aaccee)}</style>
      <h1>Screenshot at a usable width</h1><svg id="chart" viewBox="0 0 800 240"><rect width="800" height="240" fill="#dfebfa"/><circle cx="120" cy="90" r="40" fill="#175fb5"/><text x="200" y="110" font-size="32">Readable chart</text></svg>
      <canvas id="canvas" width="640" height="300"></canvas><div class="long"></div>
      <script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#175fb5';c.fillRect(0,0,640,300);c.fillStyle='white';c.font='32px Arial';c.fillText('Canvas export',50,150);</script>`));
    page.debugger.attach('1.3');
    const commands = [];
    const connector = async (method, params) => {
      if (method === 'tabs.list') return [{ id: 42, active: true }];
      if (method === 'debugger.command') {
        commands.push(params.command);
        let timer;
        try { return await Promise.race([page.debugger.sendCommand(params.command, params.commandParams),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CDP fixture timed out: ${params.command}`)), 8000); })]); }
        finally { clearTimeout(timer); }
      }
      throw new Error('Unexpected connector method ' + method);
    };
    const server = createCardbushChromeServer({ connector, artifactsDirectory: path.join(root, 'artifacts') });
    const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'capture-fixture' } } };
    const call = async (name, args) => {
      const result = await server._registeredTools[name].handler(args, context);
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
      return result;
    };
    await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 69, height: 2693, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.executeJavaScript('innerWidth'), 69);
    const screenshot = await call('take_screenshot', { format: 'png', fullPage: true, autoViewport: true });
    assert.equal(screenshot.structuredContent.viewport.adjusted, true);
    assert.equal(screenshot.structuredContent.viewport.width, 1280);
    assert.equal(screenshot.structuredContent.width, screenshot.structuredContent.clip.width);
    assert.ok(screenshot.structuredContent.width >= 1200);
    assert.ok(screenshot.structuredContent.height > 2400, 'full page extends beyond the repaired 800px viewport');
    assert.equal(screenshot.content[1].type, 'image');
    assert.deepEqual(await fs.readFile(screenshot.structuredContent.path), Buffer.from(screenshot.content[1].data, 'base64'));
    await call('resize_page', { width: 360, height: 640 });
    const mobile = await call('take_screenshot', { format: 'png', autoViewport: true });
    assert.equal(mobile.structuredContent.width, 360); assert.equal(mobile.structuredContent.height, 640);
    await call('resize_page', { width: 69, height: 640 });
    assert.equal((await call('take_screenshot', { format: 'png' })).structuredContent.width, 69, 'explicit narrow tests are respected');
    const chart = await call('take_screenshot', { format: 'png', selector: '#chart', viewport: { width: 900, height: 640 } });
    assert.equal(chart.structuredContent.width, chart.structuredContent.clip.width); assert.equal(chart.structuredContent.height, 240);
    assert.ok(chart.structuredContent.width >= 880);
    const canvas = await call('export_image', { selector: '#canvas', format: 'png' });
    assert.equal(canvas.structuredContent.width, 640); assert.equal(canvas.structuredContent.height, 300);
    const expression = `JSON.stringify({url:document.querySelector('canvas').toDataURL('image/png')})`;
    const exported = await call('export_image', { expression, format: 'png' });
    const automatic = await call('evaluate_script', { expression });
    assert.equal(exported.structuredContent.path, canvas.structuredContent.path);
    assert.equal(automatic.content[1].type, 'image', 'the original JSON-stringified data URL becomes an image without another tool call');
    const svg = await call('export_image', { selector: '#chart', format: 'png', viewport: { width: 900, height: 640 } });
    assert.ok(svg.structuredContent.width >= 880);
    assert.ok(!automatic.content[0].text.includes('base64'), 'no Base64 text enters model context');
    const registry = new ToolRegistry();
    registry.register({ definition: { name: 'mcp_call', description: 'capture fixture', inputSchema: { type: 'object' } },
      manifest: { effect_kind: 'observation', operation: 'mcp.call', risk: 'low', owner: 'test', dispatch_scope: 'process', mutating: false },
      decodeInput: value => value, execute: () => ({ mcp: { name: 'mcp__chrome_devtools__evaluate_script' }, result: automatic }),
      renderModelResult: value => JSON.stringify(value) });
    const loop = new RuntimeToolLoop({ eventLog: new InMemoryRuntimeEventLog(), identity: { requestId: 'r', sessionId: 's', turnId: 't' },
      registry, executionStore: new ToolExecutionStore(), modelImages: new ModelImageStore(path.join(root, 'model')) });
    const { messages } = await loop.execute([{ protocol: 'bush.tool_call.v1', id: 'capture', name: 'mcp_call', argumentsText: '{}' }],
      { round: 1, assistantMessageId: 'a', request: { requestCapabilities: { vision: true } } });
    assert.equal(messages.at(-1).images.length, 1);
    assert.match(messages.at(-1).content, /"status":"attached"/);
    assert.ok(messages.at(-1).content.length < 4000);
    const missing = await server._registeredTools.export_image.handler({ selector: '#missing', format: 'png' }, context);
    assert.equal(missing.isError, true, 'missing elements return an explicit error');
    assert.ok(commands.includes('Page.getLayoutMetrics'));
    await fs.mkdir(path.resolve('tmp'), { recursive: true });
    await fs.copyFile(chart.structuredContent.path, path.resolve('tmp/chrome-capture-chart.png'));
    console.log('Real CDP: 69px viewport recovery, full-page bounds, explicit mobile viewport, chart crop, canvas export, automatic image return and mcp_call vision delivery passed.');
  } catch (error) { console.error('Capture fixture failed:', error); throw error; }
  finally {
    window?.destroy();
  }
})().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
