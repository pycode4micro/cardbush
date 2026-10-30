const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ read, until, click, pause, win, directory }) => {
  await read(`{
    const now=new Date(),at=(day,hour,minute,second=0)=>new Date(now.getFullYear(),now.getMonth(),now.getDate()+day,hour,minute,second).toISOString();
    window.timelineFixture=[at(0,15,6),at(0,15,6,30),at(0,15,7),at(0,15,7,20),at(0,15,13),at(0,23,59),at(1,0,1)]
      .map((createdAt,i)=>({id:'time-'+i,role:i%2?'assistant':'user',content:'聊天消息 '+i,createdAt,source:i%2?'page':'text',visibility:'conversation'}));
    fixture.entries=timelineFixture.slice(0,4);fixture.generation=(fixture.generation??0)+1;window.dispatchEvent(new Event('cardbush:assistant-reset'));
  }void 0`);
  await until('document.querySelectorAll(".assistant-messages .assistant-message").length===4');
  assert.equal(await read('document.querySelectorAll(".assistant-messages .assistant-time-separator").length'),1);
  assert.equal(await read('document.querySelectorAll(".assistant-message time").length'),0,'consecutive messages have no individual timestamps');
  await read('fixture.entries.push(...timelineFixture.slice(4));void 0');
  await until('document.querySelectorAll(".assistant-messages .assistant-message").length===7');
  assert.equal(await read('document.querySelectorAll(".assistant-messages .assistant-time-separator").length'),4,'long gaps and midnight add separators');
  assert.deepEqual(await read('Array.from(document.querySelectorAll(".assistant-messages .assistant-time-separator time")).map(node=>node.dateTime)'),await read('[timelineFixture[0],timelineFixture[4],timelineFixture[5],timelineFixture[6]].map(item=>item.createdAt)'));
  for(const theme of ['dark','bright']){
    await read('fixture.theme('+JSON.stringify(theme)+');void 0');win.setSize(640,720);await pause(150);
    const positions=await read(`Array.from(document.querySelectorAll('.assistant-messages .assistant-time-separator')).map(node=>{const r=node.getBoundingClientRect(),p=node.parentElement.querySelector('.assistant-message-row').getBoundingClientRect();return {delta:(r.left+r.right-p.left-p.right)/2,align:getComputedStyle(node).textAlign}})`);
    assert.ok(positions.every(item=>Math.abs(item.delta)<1&&item.align==='center'),JSON.stringify(positions));
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);
    fs.writeFileSync(path.join(directory,'assistant-timestamps-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  await read(`fixture.entries=Array.from({length:20},(_,i)=>({...timelineFixture[i%4],id:'recent-'+i,content:'连续消息 '+i,createdAt:new Date(Date.parse(timelineFixture[0].createdAt)+i*60000).toISOString()}));fixture.generation++;window.dispatchEvent(new Event('cardbush:assistant-reset'));void 0`);
  await until('document.querySelectorAll(".assistant-messages .assistant-message").length===20');
  assert.equal(await read('document.querySelectorAll(".assistant-messages .assistant-time-separator").length'),1);
  await read('fixture.portal(true);void 0');await until('!!document.querySelector(".quick-input-status")');await click('.quick-input-status');
  await until('!!document.querySelector(".quick-input-transcript .assistant-time-separator")');
  assert.equal(await read('document.querySelectorAll(".quick-input-transcript .assistant-time-separator").length'),1);
  assert.equal(await read('document.querySelector(".quick-input-transcript .assistant-time-separator time").dateTime'),await read('fixture.entries[8].createdAt'),'the truncated transcript still identifies the first visible group');
  console.log('Assistant timeline passed: no per-message timestamps, long-gap/midnight separators, centered responsive themes and quick transcript grouping. Screenshots: '+directory);
};
