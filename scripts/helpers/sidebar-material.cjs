const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');

// The child process has an isolated USERPROFILE. Use two known wallpaper
// colors so the assertions don't depend on a developer's desktop.
exports.seedWallpaper = root => {
  const target = path.join(root, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Themes');
  fs.mkdirSync(target, { recursive: true });
  const bitmap = Buffer.alloc(32 * 32 * 4);
  for (let pixel = 0; pixel < 32 * 32; pixel++) {
    const [r, g, b] = pixel < 32 * 16 ? [205, 83, 49] : [48, 119, 221];
    bitmap.set([b, g, r, 255], pixel * 4);
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: 32, height: 32 });
  fs.writeFileSync(path.join(target, 'TranscodedWallpaper'), image.toPNG(), { flag: 'wx' });
};

exports.inspect = async ({ win, read, click, wait, pause, project }) => {
  const reports = [];
  const snapshot = async label => {
    const report = await read(`(() => {
      const rail = document.querySelector('.sidebar'), style = getComputedStyle(rail);
      const field = getComputedStyle(rail, '::before');
      const rect = rail.getBoundingClientRect();
      return { label: ${JSON.stringify(label)}, layout: document.querySelector('.desktop-shell').dataset.sidebarLayout,
        material: document.documentElement.dataset.windowMaterial,
        reduce: matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)').matches,
        sidebar: style.backgroundColor, filter: style.backdropFilter,
        shell: getComputedStyle(document.querySelector('.desktop-shell')).backgroundColor,
        page: getComputedStyle(document.querySelector('.main-stage')).backgroundColor,
        wallpaperLayer: field.display !== 'none' && field.backgroundImage.includes('data:image/png'),
        viewportWidth: innerWidth, railWidth: rect.width, railHeight: rect.height };
    })()`);
    const image = await win.webContents.capturePage(), size = image.getSize(), pixels = image.toBitmap();
    const scale = size.width / report.viewportWidth;
    const sample = (fraction, left = report.railWidth - 34) => {
      const x = Math.floor(left * scale), y = Math.floor(report.railHeight * fraction * scale);
      const i = 4 * (size.width * y + x);
      // A transparent native backdrop is composed by DWM after this renderer capture.
      return [pixels[i + 2], pixels[i + 1], pixels[i], pixels[i + 3]];
    };
    if (report.layout === 'docked') {
      report.pageEdge = [sample(.17, report.railWidth + 12), sample(.88, report.railWidth + 12)];
      report.readingSurface = [sample(.17, report.viewportWidth - 46), sample(.88, report.viewportWidth - 46)];
    }
    report.upperRGBA = sample(.17);
    report.lowerRGBA = sample(.88);
    reports.push(report);
    console.log('[sidebar-material]', JSON.stringify(report));
    return report;
  };

  const translucent = await read("document.documentElement.dataset.windowMaterial === 'mica' && !matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)').matches");
  if (translucent) {
    await wait(() => read("getComputedStyle(document.querySelector('.sidebar')).getPropertyValue('--sidebar-wallpaper-field').includes('data:image/png')"), 'wallpaper colors arrived');
  }
  const docked = await snapshot('docked chat');
  assert.equal(docked.layout, 'docked');
  const checkSolidRail = report => {
    assert.equal(report.filter, 'none');
    assert.equal(report.wallpaperLayer, false);
    assert.equal(report.upperRGBA[3], 255);
    assert.equal(report.lowerRGBA[3], 255);
  };
  checkSolidRail(docked);
  assert.deepEqual(docked.pageEdge, docked.readingSurface, 'the page has the same solid surface at its edge and in the reading area');
  win.setContentSize(1160, 740);
  await wait(() => read("!!document.querySelector('.desktop-shell[data-sidebar-layout=drawer].sidebar-is-collapsed')"), 'drawer layout');
  await pause(300);
  checkSolidRail(await snapshot('collapsed rail'));
  await click('.window-sidebar-toggle');
  await pause(400);
  const drawer = await snapshot('drawer over plain chat');
  if (translucent) {
    assert.ok(drawer.wallpaperLayer, 'only the open overlay has a wallpaper layer');
    assert.ok(drawer.upperRGBA[0] > drawer.upperRGBA[2] && drawer.lowerRGBA[2] > drawer.lowerRGBA[0], 'open drawer takes on its backdrop colors');
  }

  if (!drawer.reduce) {
    const previous = await read("document.querySelector('.main-stage').style.background");
    const pageColor = color => read("document.querySelector('.main-stage').style.background = " + JSON.stringify(color));
    try {
      await pageColor('#da8042');
      await pause(150);
      const warm = await snapshot('warm page under drawer');
      await pageColor('#3689e0');
      await pause(150);
      const cool = await snapshot('cool page under drawer');
      assert.notDeepEqual(warm.upperRGBA, [218, 128, 66, 255], 'the drawer is in front of the page sample');
      assert.ok(warm.upperRGBA[0] > cool.upperRGBA[0] + 20);
      assert.ok(cool.upperRGBA[2] > warm.upperRGBA[2] + 20);
    } finally { await pageColor(previous); }
  }

  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{name:'prefers-reduced-transparency',value:'reduce'}],
    });
    await wait(() => read("matchMedia('(prefers-reduced-transparency: reduce)').matches"), 'reduced transparency');
    const opaque = await snapshot('reduced transparency');
    assert.equal(opaque.filter, 'none');
    assert.equal(opaque.wallpaperLayer, false);
    assert.equal(await read("getComputedStyle(document.querySelector('.main-stage')).backgroundImage"), 'none', 'reduced transparency restores a solid page');
    assert.equal(opaque.upperRGBA[3], 255, 'the drawer is opaque when transparency is reduced');
  } finally { win.webContents.debugger.detach(); }
  await click('.window-sidebar-toggle');
  await pause(300);
  checkSolidRail(await snapshot('closed again'));
  fs.writeFileSync(path.join(project, 'tmp', 'sidebar-material-check.json'), JSON.stringify(reports, null, 2));
};
