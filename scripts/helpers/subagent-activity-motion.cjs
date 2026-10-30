const assert = require('node:assert/strict');

module.exports = async ({ read, pause, window, selector, rerender }) => {
  const selected = JSON.stringify(selector);
  await window.webContents.debugger.attach('1.3');
  const media = async value => {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const snapshot = () => read(`(()=>{const node=document.querySelector(${selected}),animation=node.getAnimations().find(a=>a.animationName==='subagent-activity-turn'),rect=node.getBoundingClientRect();return {count:animation?1:0,time:animation?.currentTime,state:animation?.playState,transform:getComputedStyle(node).transform,center:[rect.x+rect.width/2,rect.y+rect.height/2]}})()`);
  await read(`window.activityMotionOriginal={motion:document.documentElement.dataset.motionPreference,reduce:document.documentElement.dataset.reduceMotion,visible:document.documentElement.dataset.windowVisible};delete document.documentElement.dataset.motionPreference;delete document.documentElement.dataset.reduceMotion;document.documentElement.dataset.windowVisible='true';void 0`);
  try {
    await media('no-preference');
    const before = await snapshot();
    assert.equal(before.count, 1, 'running icon has a real animation, not just an unresolved animation name');
    await pause(160);
    const after = await snapshot();
    assert.ok(after.time>before.time+50, JSON.stringify({before,after}));
    assert.notEqual(after.transform, before.transform, 'the icon actually rotates');
    assert.ok(after.center.every((value,index)=>Math.abs(value-before.center[index])<.5), 'rotation stays centered');
    await read(`window.activityMotionProbe={node:document.querySelector(${selected}),animation:document.querySelector(${selected}).getAnimations()[0]};${rerender};void 0`);
    await pause(60);
    assert.equal(await read(`document.querySelector(${selected})===activityMotionProbe.node&&document.querySelector(${selected}).getAnimations().includes(activityMotionProbe.animation)`), true, 'status refresh preserves the DOM and animation clock');
    await read(`document.documentElement.dataset.motionPreference='on';document.documentElement.dataset.reduceMotion='true';void 0`);
    assert.equal((await snapshot()).count, 0, 'explicit reduced motion stops the spinner');
    await media('reduce');
    await read(`document.documentElement.dataset.motionPreference='off';document.documentElement.dataset.reduceMotion='false';void 0`);
    assert.equal((await snapshot()).count, 1, 'explicit animations override OS reduced motion');
    await read(`delete document.documentElement.dataset.motionPreference;delete document.documentElement.dataset.reduceMotion;void 0`);
    assert.equal((await snapshot()).count, 0, 'automatic preference follows OS reduced motion');
    await media('no-preference');
    assert.equal((await snapshot()).count, 1);
    await read(`document.documentElement.dataset.windowVisible='false';void 0`);
    await pause(50);
    const paused = await snapshot(); await pause(100);
    const held = await snapshot();
    assert.equal(held.state, 'paused'); assert.ok(Math.abs(held.time-paused.time)<2, 'hidden windows do not keep rotating');
    await read(`document.documentElement.dataset.windowVisible='true';void 0`);
    await pause(80); assert.equal((await snapshot()).state, 'running');
    console.log('Subagent activity motion passed: '+selector+' rotates, stays centered, survives refresh, honors app/OS preferences and pauses when hidden.');
  } finally {
    await read(`for(const [key,value] of Object.entries({motionPreference:activityMotionOriginal.motion,reduceMotion:activityMotionOriginal.reduce,windowVisible:activityMotionOriginal.visible})){if(value===undefined)delete document.documentElement.dataset[key];else document.documentElement.dataset[key]=value}delete window.activityMotionOriginal;delete window.activityMotionProbe;void 0`);
    await window.webContents.debugger.detach();
  }
};
