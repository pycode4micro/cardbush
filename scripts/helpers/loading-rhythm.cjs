const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.showLoadingFixture = (loading, history = false) => renderView(loading
      ? h(views.BackendLoading, { language: 'zh', history })
      : h('p', { id: 'loaded-conversation' }, '会话已加载'));
    showLoadingFixture(true);
  `);
  await until("document.querySelectorAll('.loading-rhythm span').length === 5", 'runtime loading bars');
  const measurements = await run(`(() => {
    const rhythm = document.querySelector('.loading-rhythm');
    const bars = [...rhythm.children];
    const animations = bars.map(bar => bar.getAnimations()[0]);
    window.runtimeLoadingBars = bars;
    window.runtimeLoadingAnimations = animations;
    animations.forEach(animation => animation.pause());
    return [0, 120, 300, 450, 650, 960].map(time => {
      animations.forEach(animation => { animation.currentTime = time; });
      const bounds = rhythm.getBoundingClientRect();
      return { height: bounds.height, top: bounds.top, bars: bars.map((bar, index) => {
        const box = bar.getBoundingClientRect();
        return { layoutHeight: bar.offsetHeight, visibleHeight: box.height,
          inside: box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
          delay: animations[index].effect.getTiming().delay,
          layoutAnimation: animations[index].effect.getKeyframes().some(frame => 'height' in frame || 'width' in frame) };
      }) };
    });
  })()`);
  assert.equal(new Set(measurements.map(frame => frame.height)).size, 1, 'wave container never resizes');
  assert.equal(new Set(measurements.map(frame => frame.top)).size, 1, 'wave container never shifts');
  for (const frame of measurements) for (const bar of frame.bars) {
    assert.equal(bar.layoutHeight, 30, 'bars keep a fixed layout height');
    assert.equal(bar.layoutAnimation, false, 'animation only transforms/changes opacity');
    assert.ok(bar.inside, 'wave stays inside reserved bounds');
    assert.ok(bar.delay <= 0, 'no delayed initial pop');
  }
  assert.ok(new Set(measurements.map(frame => Math.round(frame.bars[0].visibleHeight))).size > 1, 'wave still visibly animates');
  await run('showLoadingFixture(true, true)');
  await until("document.querySelector('.loading-view p')?.textContent.includes('正在加载会话')", 'history loading uses shared wave');
  assert.equal(await run("document.querySelector('.loading-rhythm span') === runtimeLoadingBars[0]"), true, 'loading phase changes do not remount bars');
  assert.equal(await run("document.querySelector('.loading-rhythm span').getAnimations()[0] === runtimeLoadingAnimations[0]"), true, 'loading phase changes do not restart animation');

  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(50);
    assert.equal(await run("document.querySelector('.loading-rhythm').getAnimations({ subtree: true }).length"), 0, 'reduced motion has no delayed or infinite wave');
    assert.equal(await run("getComputedStyle(document.querySelector('.loading-rhythm span')).opacity"), '0.7', 'static indicator remains visible');
  } finally {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    window.webContents.debugger.detach();
  }
  await run('showLoadingFixture(false)');
  await until("!!document.querySelector('#loaded-conversation') && !document.querySelector('.loading-rhythm')", 'completion removes loading wave');
  assert.equal(await run("document.getAnimations().filter(animation => animation.animationName === 'loading-rhythm').length"), 0, 'no wave animation survives completion');
  console.log('Loading rhythm passed: fixed layout, bounded transform, immediate stagger, phase continuity, reduced motion and cleanup on completion.');
};
