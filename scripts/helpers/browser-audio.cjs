const assert = require('node:assert/strict');

function toneDataUrl() {
  const rate = 8000, samples = rate, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(327 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return 'data:audio/wav;base64,' + wav.toString('base64');
}

// Real Chromium audio -> main/preload notification -> React tab -> native mute.
// Isolated guest/profile; short, low-volume test tone, no remote requests.
module.exports = async ({ window, original, origin, read, waitFor, activeReady, until, click, webContents }) => {
  await original.loadURL(origin + '/tab-design'); await activeReady();
  const firstId = await read('browserFixture.activeId');
  const tab = id => `[data-inspector-tab-id=${JSON.stringify(id)}]`;
  const audio = id => tab(id) + ' .right-inspector-tab-audio';
  const button = id => `document.querySelector(${JSON.stringify(audio(id))})`;
  const nav = id => `browserFixture.navigation[${JSON.stringify(id)}]`;
  assert.equal(await read(button(firstId)), null, 'silent tabs reserve no audio button');

  // A playing video with no audio track must not be mistaken for an audible tab.
  await original.executeJavaScript(`(async()=>{
    const canvas=document.createElement('canvas'); canvas.width=32; canvas.height=32;
    window.silentVideo=document.createElement('video'); silentVideo.srcObject=canvas.captureStream(5);
    window.silentFrames=setInterval(()=>{canvas.getContext('2d').fillRect(0,0,32,32);},100);
    document.body.append(silentVideo); await silentVideo.play();
  })()`, true);
  assert.equal(original.isCurrentlyAudible(), false, 'silent video does not emit sound');
  assert.equal(await read(button(firstId)), null, 'media playing alone does not reveal mute');
  await original.executeJavaScript('clearInterval(silentFrames); silentVideo.pause(); silentVideo.srcObject.getTracks().forEach(track=>track.stop()); silentVideo.remove(); void 0');

  await original.executeJavaScript(`(async()=>{
    window.testAudio=new Audio(${JSON.stringify(toneDataUrl())}); testAudio.loop=true;
    document.body.append(testAudio); await testAudio.play();
  })()`, true);
  await until(() => original.isCurrentlyAudible(), 'native HTML audio is audible');
  await waitFor(`${nav(firstId)}.audible && ${button(firstId)}?.getAttribute('aria-pressed')==='false'`, 'audio event reaches the tab');
  const bounds = await read(`(()=>{const b=${button(firstId)}.getBoundingClientRect(); const c=${button(firstId)}.nextElementSibling.getBoundingClientRect();return {width:b.width,height:b.height,right:b.right,closeLeft:c.left};})()`);
  assert.ok(bounds.width >= 24 && bounds.height >= 24 && bounds.right <= bounds.closeLeft + 1, 'mute appears immediately left of close');
  await click(window.webContents, audio(firstId));
  await until(() => original.isAudioMuted(), 'tab control mutes the native guest');
  await waitFor(`${button(firstId)}?.getAttribute('aria-pressed')==='true'`, 'muted tab keeps an unmute control');
  assert.deepEqual(await original.executeJavaScript('({paused:testAudio.paused,muted:testAudio.muted,volume:testAudio.volume})'), { paused:false, muted:false, volume:1 }, 'native mute preserves player state');
  await click(window.webContents, audio(firstId));
  await until(() => !original.isAudioMuted(), 'tab unmute restores native output');
  await original.executeJavaScript('testAudio.pause(); void 0');
  await until(() => !original.isCurrentlyAudible(), 'paused media stops emitting audio');
  await waitFor(`${button(firstId)}===null`, 'silent unmuted tab hides control again');

  // Web Audio in a child frame is aggregated by Chromium, including in background tabs.
  await original.executeJavaScript(`(async()=>{
    const frame=document.createElement('iframe'); frame.id='audio-frame';
    const loaded=new Promise(resolve=>frame.onload=resolve); frame.src='about:blank'; document.body.append(frame); await loaded;
    const context=new frame.contentWindow.AudioContext(); window.testContext=context;
    const gain=context.createGain(); gain.gain.value=.01; gain.connect(context.destination);
    const tone=context.createOscillator(); tone.connect(gain); tone.start(); await context.resume();
  })()`, true);
  await until(() => original.isCurrentlyAudible(), 'iframe Web Audio is audible');
  await waitFor(`${button(firstId)}!==null`, 'Web Audio displays tab control');
  await read(`browserFixture.open({target:${JSON.stringify(origin + '/tab-design?second')},newTab:true}); void 0`); await activeReady();
  const secondId = await read('browserFixture.activeId');
  const second = webContents.fromId(await read(`${nav(secondId)}.guestWebContentsId`));
  assert.equal(await read(button(secondId)), null, 'silent neighbor does not inherit indicator');
  await click(window.webContents, audio(firstId));
  await until(() => original.isAudioMuted(), 'background tab can be muted');
  assert.equal(await read('browserFixture.activeId'), secondId, 'background mute does not select the tab');
  assert.equal(second.isAudioMuted(), false, 'muting is isolated per guest');
  await original.executeJavaScript('testContext.close()');
  await until(() => !original.isCurrentlyAudible(), 'closed audio context is silent');
  await waitFor(`${button(firstId)}?.getAttribute('aria-pressed')==='true'`, 'silent muted tab remains recoverable');

  // Reload and same-tab navigation preserve the native mute choice.
  original.reload();
  await until(() => !original.isLoading(), 'muted background reload');
  await waitFor(`${nav(firstId)}.audioMuted===true && ${button(firstId)}!==null`, 'reload preserves unmute button');
  await original.loadURL(origin + '/same');
  await waitFor(`${nav(firstId)}.url===${JSON.stringify(origin + '/same')} && ${nav(firstId)}.loading===false`, 'muted same-tab navigation');
  assert.equal(original.isAudioMuted(), true, 'navigation retains mute in the same guest');
  await click(window.webContents, audio(firstId));
  await until(() => !original.isAudioMuted(), 'silent page can be unmuted');
  await waitFor(`${button(firstId)}===null`, 'unmuting silent page removes button');
  await click(window.webContents, tab(firstId) + ' .right-inspector-tab-close');
  await until(() => original.isDestroyed(), 'closing tab releases guest audio lifecycle');
  assert.equal(await read('browserFixture.activeId'), secondId);
  assert.equal(second.isAudioMuted(), false);
  assert.equal(await read('document.querySelectorAll(".right-inspector-tab-audio").length'), 0);
  console.log('Browser audio passed: silent/video tabs hidden, native HTML and iframe Web Audio events, mute/unmute without pausing, button placement, background isolation, reload/navigation retention, and guest cleanup.');
};
