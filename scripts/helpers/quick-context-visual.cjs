const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Count the painted lines independently of the virtual list and its diagnostic.
// Sample the stroke near its left end against the background on the same row.
function paintedLines(image, x, y, height) {
  const { width, height: rows } = image.getSize();
  const pixels = image.toBitmap();
  const runs = [];
  for (let row = 0; row < rows; row++) {
    const ink = 4 * (row * width + x), background = ink - 8 * 4;
    if (![0, 1, 2].some(channel => Math.abs(pixels[ink + channel] - pixels[background + channel]) > 6)) continue;
    if (runs.at(-1)?.end === row - 1) runs.at(-1).end = row;
    else runs.push({ start: row, end: row });
  }
  return { count: runs.length, outside: runs.some(line => line.start < y || line.end >= y + height) };
}

module.exports = async function testQuickContextVisual({ run, until, pause, window, root }) {
  const directory = path.join(root, 'tmp', 'quick-context-20x5');
  fs.mkdirSync(directory, { recursive: true });
  const previousDebug = await run('sessionStorage.getItem("cardbush_scroll_debug")');
  await run(`sessionStorage.setItem('cardbush_scroll_debug','true');
    renderView(h(views.QuickContextPreTest, { language: 'zh' })); void 0;`);
  try {
    await until("document.querySelector('.quick-context-pre-test-feed') && document.querySelector('.quick-context-ticks')?.clientHeight > 0", 'visible pre-test rail');
    await run(`window.limitTrack = document.querySelector('.quick-context-ticks');
      window.limitFeed = document.querySelector('.quick-context-pre-test-feed');
      window.limitSample = () => window.__cardbushScrollDebug?.filter(row => row.label === 'quick-context-viewport').at(-1);
      limitFeed.scrollTop = 180; void 0;`);
    await until('limitSample()?.total === 20 && limitSample().capacity === 5 && limitFeed.scrollTop > 0', 'twenty turns with five slots');
    const feedTop = await run('limitFeed.scrollTop');
    const max = await run('limitTrack.scrollHeight - limitTrack.clientHeight');
    const step = await run('parseFloat(getComputedStyle(limitTrack).getPropertyValue("--context-tick-step"))');
    const point = await run('(()=>{const r=limitTrack.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()');
    const wheel = deltaY => window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY, deltaX: 0 });
    async function rollToEdge(bottom) {
      const target = bottom ? max : 0;
      for (let repeat = 0; repeat < 8; repeat++) {
        if (Math.abs(await run('limitTrack.scrollTop') - target) <= 1) return;
        wheel(bottom ? -240 : 240);
        await pause(150);
      }
      assert.fail('wheel did not reach scrollTop ' + target);
    }
    const samples = [];
    async function capture(stage) {
      await until('limitSample()?.scrollTop === limitTrack.scrollTop', 'committed viewport log');
      const { rect, sample, transcriptTop } = await run(`({rect:limitTrack.getBoundingClientRect().toJSON(),sample:limitSample(),transcriptTop:limitFeed.scrollTop})`);
      const crop = { x: Math.floor(rect.left) - 8, y: Math.floor(rect.top) - 12,
        width: Math.ceil(rect.width) + 16, height: Math.ceil(rect.bottom) - Math.floor(rect.top) + 24 };
      const image = await window.webContents.capturePage(crop);
      const paint = paintedLines(image, 11, Math.round(rect.top - crop.y), Math.round(rect.height));
      fs.writeFileSync(path.join(directory, stage + '.png'), image.toPNG());
      samples.push({ stage, ...sample, transcriptTop, painted: paint.count, paintOutside: paint.outside });
    }
    await run('limitTrack.scrollTop = 0; void 0'); await capture('top');
    wheel(240); await pause(180); await capture('top-boundary');
    wheel(-4 * step);
    await until('limitTrack.scrollTop > 0 && limitTrack.scrollTop < limitTrack.scrollHeight - limitTrack.clientHeight', 'native wheel enters the middle');
    await pause(180);
    wheel(-4 * step);
    await pause(250); await capture('middle');
    await rollToEdge(true); await capture('bottom');
    wheel(-240); await pause(180); await capture('bottom-boundary');
    await rollToEdge(false); await capture('return');
    // Sample every sub-row phase too: an extra sliver is easy to miss at a settled offset.
    for (let offset = 0; offset < step; offset++) {
      await run(`limitTrack.scrollTop = ${8 * step + offset}; void 0`);
      await capture('phase-' + offset);
    }
    fs.writeFileSync(path.join(directory, 'viewport.json'), JSON.stringify(samples, null, 2));
    console.log('Quick context visual:', JSON.stringify(samples.slice(0, 6).map(({ stage, firstTurn, lastTurn, painted, scrollTop }) =>
      ({ stage, firstTurn, lastTurn, painted, scrollTop }))));
    for (const sample of samples) {
      assert.equal(sample.transcriptTop, feedTop, sample.stage + ': wheel stays in the rail');
      assert.equal(sample.paintOutside, false, sample.stage + ': no paint outside the viewport');
      assert.ok(sample.painted >= 4 && sample.painted <= 5, sample.stage + ': expected at most five painted ticks, got ' + sample.painted);
      assert.ok(sample.visible <= 5 && sample.mounted <= 8, sample.stage + ': clipped contiguous viewport with bounded overscan');
    }
    for (const [index, first] of [[0, 1], [1, 1], [3, 16], [4, 16], [5, 1]]) {
      assert.deepEqual([samples[index].firstTurn, samples[index].lastTurn, samples[index].painted], [first, first + 4, 5]);
    }
    assert.equal(max, (20 - 5) * step);
  } finally {
    await run(previousDebug === null ? 'sessionStorage.removeItem("cardbush_scroll_debug")'
      : 'sessionStorage.setItem("cardbush_scroll_debug",' + JSON.stringify(previousDebug) + ')');
  }
};
