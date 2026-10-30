const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ read, until, fill, click, pause, win, directory }) => {
  const portrait = path.join(directory, 'portrait.png'), wide = path.join(directory, 'wide.png'), square = path.join(directory, 'square.png');
  for (const [file, width, height, color] of [[portrait, 400, 900, '#667e73'], [wide, 1200, 400, '#687ea0'], [square, 600, 600, '#a5876e']]) {
    const data = await read(`(()=>{const c=document.createElement('canvas');c.width=${width};c.height=${height};const x=c.getContext('2d');x.fillStyle=${JSON.stringify(color)};x.fillRect(0,0,c.width,c.height);x.fillStyle='#e4c3a3';x.beginPath();x.arc(c.width/2,c.height*.35,Math.min(c.width,c.height)*.15,0,Math.PI*2);x.fill();x.fillStyle='#fff';x.fillRect(0,c.height-30,c.width,15);return c.toDataURL().split(',')[1]})()`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  const filePath = path.join(directory, 'Product notes and references with a very long filename.txt');
  fs.writeFileSync(filePath, 'fixture');
  const pick = async paths => {
    await read('fixture.picks=' + JSON.stringify(paths) + ';void 0');
    await click('.composer-tools .tool-chip');
    await read('Array.from(document.querySelectorAll(".composer-popover button")).find(n=>n.textContent.includes("文件和文件夹")).click();void 0');
  };
  await read(`fixture.entries=[];fixture.generation=(fixture.generation??0)+1;window.dispatchEvent(new Event('cardbush:assistant-reset'));
    cardbushDesktop.pickAttachments=async()=>fixture.picks;
    cardbushDesktop.inspectAttachments=async paths=>paths.map(path=>({path,name:path.split(/[\\\\/]/).pop(),kind:'file',size:2048}));void 0`);
  await until('document.querySelectorAll(".assistant-message").length===0');
  const ordinaryReply = await read(`(()=>{const node=document.createElement('div');node.className='assistant-message-content';document.querySelector('.app').append(node);const style=getComputedStyle(node),result={padding:style.paddingTop,background:style.backgroundColor};node.remove();return result})()`);
  assert.deepEqual(ordinaryReply, { padding: '0px', background: 'rgba(0, 0, 0, 0)' }, 'assistant bubble styles do not leak into ordinary agent replies');
  await fill('textarea', '用这张图生成视频。');
  await pause(100);
  const originalHeight = await read('document.querySelector(".composer-surface").getBoundingClientRect().height');
  await pick([portrait, filePath]);
  await until('document.querySelector(".composer-image-preview img")?.naturalWidth===400 && !!document.querySelector(".composer-file-attachment")');
  const input = await read(`(()=>{const tray=document.querySelector('.composer-attachments'),surface=document.querySelector('.composer-surface');return {
    separate:!surface.contains(tray),above:tray.getBoundingClientRect().bottom<=surface.getBoundingClientRect().top,
    height:surface.getBoundingClientRect().height,fit:getComputedStyle(tray.querySelector('img')).objectFit,draft:surface.querySelector('textarea').value}})()`);
  assert.equal(input.separate, true); assert.equal(input.above, true); assert.ok(Math.abs(input.height-originalHeight)<1, JSON.stringify(input));
  assert.equal(input.fit, 'contain'); assert.equal(input.draft, '用这张图生成视频。');
  await click('.composer-image-preview'); await until('!!document.querySelector(".image-preview-dialog")');
  await until('document.querySelector(".image-preview-stage img")?.naturalHeight===900');
  await click('.image-preview-close');
  await until('!document.querySelector(".image-preview-dialog")'); await pause(100);
  fs.writeFileSync(path.join(directory, 'attachments-draft.png'), (await win.webContents.capturePage()).toPNG());
  await click('.send-button[aria-label="发送"]');
  await until('!!document.querySelector(".assistant-message-user .message-image-preview img") && !document.querySelector(".composer-attachments")');
  await until('document.querySelector(".assistant-message-user .message-image-preview img")?.naturalWidth===400');
  assert.equal(await read('document.querySelectorAll(".assistant-message-user").length'), 1);
  assert.equal(await read('document.querySelector(".assistant-text-bubble").textContent'), '用这张图生成视频。');
  assert.equal(await read('document.querySelector(".assistant-text-bubble .message-image-strip,.assistant-text-bubble .message-file-strip")'), null);
  assert.ok(await read('fixture.sent[0].text.includes(' + JSON.stringify(portrait) + ')&&fixture.sent[0].text.includes(' + JSON.stringify(filePath) + ')'), 'separation preserves the original attachment payload');
  const shape = await read(`(()=>{const image=document.querySelector('.assistant-message-user .message-image-preview img'),bubble=document.querySelector('.assistant-text-bubble'),group=document.querySelector('.user-message-attachments');const i=image.getBoundingClientRect(),b=bubble.getBoundingClientRect();return{
    ratio:i.width/i.height,width:i.width,height:i.height,gap:b.top-group.getBoundingClientRect().bottom,right:Math.abs(i.right-b.right),background:getComputedStyle(group).backgroundColor}})()`);
  assert.ok(Math.abs(shape.ratio-400/900)<.01 && shape.height<=280, JSON.stringify(shape));
  assert.ok(shape.gap>=7 && shape.right<2, JSON.stringify(shape)); assert.equal(shape.background, 'rgba(0, 0, 0, 0)');
  await click('.assistant-message-user .message-image-preview'); await until('!!document.querySelector(".image-preview-dialog")'); await click('.image-preview-close');
  for (const theme of ['dark', 'bright']) {
    for (const width of [1120, 680]) {
      win.setSize(width, 820); await read('fixture.theme(' + JSON.stringify(theme) + ');void 0'); await pause(120);
      assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
      assert.ok(await read('document.querySelector(".assistant-text-bubble").getBoundingClientRect().width<document.querySelector(".assistant-message-row").getBoundingClientRect().width*.9'), 'short text does not inherit the media width');
      fs.writeFileSync(path.join(directory, `attachments-sent-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
  }
  await read(`fixture.entries=fixture.entries.map((entry,index)=>index===0?{...entry,content:'请使用这些素材制作视频，并保留完整的人物画面。'.repeat(12),
    attachments:[...entry.attachments,...${JSON.stringify([wide, square])}.map((path,i)=>({id:'more-'+i,name:'image-'+i+'.png',type:'image',path}))]}:entry);
    fixture.generation++;window.dispatchEvent(new Event('cardbush:assistant-reset'));void 0`);
  await until('document.querySelectorAll(".assistant-message-user .message-image-gallery-thumbnail").length===3');
  await pause(100);
  const bubbleBox = () => read('(()=>{const r=document.querySelector(".assistant-text-bubble").getBoundingClientRect();return {width:r.width,height:r.height}})()');
  const before = await bubbleBox();
  await click('.assistant-message-user .message-image-gallery-thumbnail:nth-child(2)'); await pause(60);
  assert.deepEqual(await bubbleBox(), before, 'switching portrait and landscape does not change the text bubble');
  await fill('textarea', '新草稿'); await read('fixture.portal(true);void 0');
  await until('!!document.querySelector(".inspector-quick-input textarea")');
  await pick([portrait, wide, square, filePath]);
  await until('document.querySelectorAll(".inspector-quick-input .composer-image-thumb").length===3');
  assert.equal(await read('!!document.querySelector(".inspector-quick-input .composer-surface .composer-image-strip")'), false);
  assert.equal(await read('document.querySelector("textarea").value'), '新草稿');
  await click('.composer-image-remove'); await until('document.querySelectorAll(".composer-image-thumb").length===2');
  await click('.composer-file-remove'); await until('!document.querySelector(".composer-file-attachment")');
  assert.equal(await read('document.querySelector("textarea").value'), '新草稿');
  console.log('Assistant attachments passed: independent draft tray and sent cards, uncropped portrait, unchanged text surface, original payload, viewer, removal, gallery stability, portal and both responsive themes. Screenshots: ' + directory);
};
