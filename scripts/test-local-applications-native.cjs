const { app, shell, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { pickWindowsApplication, readWindowsApplicationIcons } = require('../dist-electron/windowsApplicationShortcuts.js');
const { inspectLocalApplication, launchLocalApplication } = require('../dist-electron/localApplications.js');

async function checkDesktopPicker() {
  // Capture the production helper invocation, then replace only ShowDialog with
  // a native probe so the actual dialog setup runs without displaying a window.
  const originalExecFile = childProcess.execFile;
  let invocation;
  childProcess.execFile = (executable, args, options, callback) => ({ stdin: {
    on() {},
    end(input) { invocation = { executable, args, options, input }; callback(null, 'null'); },
  } });
  try { assert.equal(await pickWindowsApplication('zh', undefined), null); }
  finally { childProcess.execFile = originalExecFile; }
  const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  const anchor = '    $answer = if ($owner.Handle';
  assert.ok(script.includes(anchor), 'probe must run just before the real ShowDialog call');
  const probe = await fs.readFile(path.join(__dirname, 'helpers/windows-application-picker.ps1'), 'utf8');
  const instrumented = script.replace(anchor, `${probe}\n${anchor}`);
  const output = childProcess.execFileSync(invocation.executable, [
    ...invocation.args.slice(0, -1), Buffer.from(instrumented, 'utf16le').toString('base64'),
  ], { ...invocation.options, input: invocation.input, timeout: 15_000 });
  const result = JSON.parse(output);
  assert.equal(result.itemIdSize, 0, 'picker opens the merged Shell desktop, not a physical user directory');
  assert.equal(result.dereferenceLinks, false, 'selecting an app must preserve its shortcut');
  assert.equal(result.filter.split('|')[1], '*.lnk;*.url', 'desktop shortcuts are selectable by default');
  const visiblePaths = new Set(result.visibleShortcuts.map(file => file.toLowerCase()));
  for (const file of result.physicalShortcuts) {
    assert.ok(visiblePaths.has(file.toLowerCase()), `desktop shortcut is visible: ${file}`);
  }
  // On a development PC, also verify the actual shared apps reported missing.
  // These optional checks do not require Edge or Steam to be installed on CI.
  const reportedApps = result.physicalShortcuts.filter(file => /[\\/](Microsoft Edge|Steam)\.lnk$/i.test(file));
  const reportedIcons = await readWindowsApplicationIcons(reportedApps);
  for (const file of reportedApps) {
    const item = await inspectLocalApplication(file, async target => reportedIcons[target]);
    assert.equal(item.path, file);
    assert.ok(!nativeImage.createFromDataURL(item.icon ?? '').isEmpty());
  }
  console.log(`Windows picker passed: merged desktop exposes ${result.physicalShortcuts.length} personal/public shortcuts; ${reportedApps.length} Edge/Steam shortcuts checked with real logos.`);
}

app.whenReady().then(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-shortcut-icons-'));
  try {
    const custom = path.join(root, "桌面 自定义 $(logo) '快捷方式.lnk");
    const normal = path.join(root, '原始应用.lnk');
    const url = path.join(root, '游戏快捷方式.url');
    const resource = path.join(root, '资源图标.lnk');
    const resource2 = path.join(root, '另一个资源图标.lnk');
    const logo = path.resolve('assets/cardbush.ico');
    const dll = path.join(process.env.SystemRoot, 'System32', 'shell32.dll');
    const args = '--shortcut-test "含空格的参数"';
    assert.ok(shell.writeShortcutLink(custom, { target: process.execPath, args, cwd: root, icon: logo, iconIndex: 0 }));
    assert.ok(shell.writeShortcutLink(normal, { target: process.execPath }));
    assert.ok(shell.writeShortcutLink(resource, { target: process.execPath, icon: dll, iconIndex: 3 }));
    assert.ok(shell.writeShortcutLink(resource2, { target: process.execPath, icon: dll, iconIndex: 23 }));
    await fs.writeFile(url, `[InternetShortcut]\r\nURL=steam://rungameid/0\r\nIconFile=${logo}\r\nIconIndex=0\r\n`);
    const originals = await Promise.all([custom, normal, url, resource, resource2].map(file => fs.readFile(file)));
    const icons = await readWindowsApplicationIcons([custom, normal, url, resource, resource2, logo]);
    for (const file of [custom, normal, url, resource, resource2]) {
      assert.match(icons[file], /^data:image\/png;base64,/);
      const image = nativeImage.createFromDataURL(icons[file]);
      assert.ok(!image.isEmpty() && image.getSize().width >= 32, 'native shortcut logo is a usable image');
    }
    const bitmap = file => nativeImage.createFromDataURL(icons[file]).toBitmap();
    const difference = (a, b) => { const x = bitmap(a), y = bitmap(b); return x.reduce((sum, byte, index) => sum + Math.abs(byte - y[index]), 0) / x.length; };
    await fs.mkdir('tmp', { recursive: true });
    for (const [name, file] of [['custom', custom], ['original', logo], ['normal', normal], ['url', url]]) await fs.writeFile(`tmp/shortcut-${name}.png`, nativeImage.createFromDataURL(icons[file]).toPNG());
    // Shell and .ico decoders can round alpha by one unit; unrelated logos
    // differ substantially. Compare the rendered pixels, not PNG encoding.
    assert.ok(difference(custom, logo) < 1, 'shortcut uses its custom logo');
    assert.ok(difference(url, logo) < 1, 'game URL shortcut uses its IconFile');
    assert.notDeepEqual(bitmap(custom), bitmap(normal), 'different shortcuts do not share the generic .lnk icon');
    assert.notDeepEqual(bitmap(resource), bitmap(resource2), 'DLL icon indices are respected');
    for (const file of [custom, url]) {
      const item = await inspectLocalApplication(file, async target => icons[target]);
      assert.equal(item.path, file, 'store the original shortcut, not its resolved executable');
      assert.equal(item.title, path.basename(file, path.extname(file)));
      assert.equal(item.iconVersion, 1);
      const launched = [];
      await launchLocalApplication(item.path, async target => { launched.push(target); return ''; });
      assert.deepEqual(launched, [file], 'Windows receives the shortcut itself when launching');
    }
    assert.equal(shell.readShortcutLink(custom).args, args);
    assert.equal(shell.readShortcutLink(custom).cwd, root);
    assert.deepEqual(await Promise.all([custom, normal, url, resource, resource2].map(file => fs.readFile(file))), originals, 'reading logos does not modify shortcuts');
    console.log('Windows shortcut icons passed: custom logos, .lnk/.url, DLL icon indices, Unicode paths, original launch paths and arguments; no apps launched.');
    await checkDesktopPicker();
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cardbush-shortcut-icons-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
