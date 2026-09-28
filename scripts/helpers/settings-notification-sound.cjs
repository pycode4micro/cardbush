const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, click, edit, window, root }) => {
  await click('个性化');
  await until("!!document.querySelector('#notification-sound-volume')");
  await run(`window.soundToggle = () => [...document.querySelectorAll('.settings-switch')].find(node => node.textContent.includes('提醒音效')).querySelector('input');
    window.soundStarts = 0; window.originalSoundContext = window.AudioContext;
    window.AudioContext = class {
      state='running'; currentTime=0; destination={};
      constructor(){window.mockSoundContext=this}
      createOscillator(){return {frequency:{},connect(){},disconnect(){},start(){soundStarts++},stop(){}}}
      createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}}}
    }; undefined;`);
  try {
    assert.equal(await run('soundToggle().checked'), true);
    assert.equal(await run("document.querySelector('#notification-sound-volume').value"), '50');
    await run('soundToggle().click()');
    await until('!soundToggle().checked');
    await edit('#notification-sound-volume', '35');
    await until("document.querySelector('.notification-sound-controls output').textContent==='35%'");
    assert.deepEqual(await run("JSON.parse(localStorage.getItem('cardbush_notification_sound_v1'))"), { enabled: false, volume: 35 });
    await click('试听');
    await until('soundStarts===2');
    assert.equal(await run('notificationSoundTest.playNotificationSound()'), false, 'muted automatic events remain silent after preview');
    await click('外观与语言'); await click('个性化');
    await until("!!document.querySelector('#notification-sound-volume')");
    assert.equal(await run('soundToggle().checked'), false);
    assert.equal(await run("document.querySelector('#notification-sound-volume').value"), '35');
    await edit('#notification-sound-volume', '0');
    await until("document.querySelector('.notification-sound-controls button').disabled");
    await run(`localStorage.setItem('cardbush_notification_sound_v1','{"enabled":true,"volume":50}');
      dispatchEvent(new StorageEvent('storage',{key:'cardbush_notification_sound_v1'}));`);
    await until("soundToggle().checked && document.querySelector('#notification-sound-volume').value==='50'");

    // Use Chromium's real audio renderer offline, without playing test sounds on the speakers.
    const samples = await run(`(async () => {
      const render = async volume => {
        const context = new OfflineAudioContext(1, 24000, 48000);
        notificationSoundTest.scheduleNotificationChime(context, volume);
        const data = (await context.startRendering()).getChannelData(0);
        return {peak:Math.max(...data.map(Math.abs)),energy:data.reduce((n,v)=>n+v*v,0),
          tail:Math.max(...data.slice(23000).map(Math.abs)),finite:[...data].every(Number.isFinite)};
      };
      return {full:await render(100),quarter:await render(25),mute:await render(0)};
    })()`);
    assert.ok(samples.full.finite && samples.full.peak > .1 && samples.full.peak < .33, 'chime is audible without clipping');
    assert.ok(samples.quarter.peak < samples.full.peak * .3, 'volume changes real output amplitude');
    assert.ok(samples.full.tail < .0001 && samples.quarter.tail < .0001, 'chime ends cleanly within half a second');
    assert.equal(samples.mute.energy, 0);
    // A hidden Electron window must also be able to start the real audio graph.
    window.webContents.setAudioMuted(true);
    await run(`mockSoundContext.state='closed';
      window.AudioContext=class extends originalSoundContext {constructor(){super();window.liveSoundContext=this}}; undefined;`);
    assert.equal(await run('notificationSoundTest.playNotificationSound(true)'), true, 'background playback needs no additional click or window focus');
    assert.equal(await run('liveSoundContext.state'), 'running');
    await run('liveSoundContext.close()');
    await run("document.querySelector('#notification-sound-volume').closest('.settings-card').scrollIntoView({block:'center'})");
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'settings-notification-sound.png'), (await window.webContents.capturePage()).toPNG());
    await edit('.settings-search input', '提醒');
    await until("document.querySelectorAll('.settings-nav').length===1");
    assert.equal(await run("document.querySelector('.settings-nav').dataset.settingsSection"), 'profile');
  } finally {
    await run('window.AudioContext = originalSoundContext; void 0');
  }
  console.log('Notification sound UI passed: defaults, mute, volume, preview, persistence, cross-window changes, search and real offline waveform.');
};
