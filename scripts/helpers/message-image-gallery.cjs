const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = async ({ win, read, until }) => {
  const frame = () => read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await win.setContentSize(880, 850);
  const photo = (width, height, color) => 'data:image/svg+xml;base64,' + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><circle cx="50%" cy="45%" r="20%" fill="#e5be91"/></svg>`).toString('base64');
  const images = [photo(800, 1400, '#456459'), photo(1600, 600, '#536884'), photo(900, 900, '#986652')];
  const single = `![portrait](${images[0]})`;
  await read(`clearFixture();fixtureMessageOverrides={content:${JSON.stringify(single)},toolExecutions:[],loopHistory:[],attachments:[]};renderFixture(false)`);
  await until('document.querySelector(".assistant-final-answer img")?.naturalWidth === 800');
  assert.equal(await read(`(() => {const img=document.querySelector('.assistant-final-answer img');return img.width<=img.closest('.markdown-content').clientWidth/2+1 && img.height<=innerHeight*.4+1})()`), true,
    'single images use at most half the text width and a compact height');

  const gallery = Array.from({ length: 9 }, (_, index) => `![image ${index + 1}](${images[index % images.length]})`).join('\n\n');
  await read(`fixtureMessageOverrides={...fixtureMessageOverrides,content:${JSON.stringify(gallery)}};renderFixture(false)`);
  await until('document.querySelectorAll(".message-image-gallery-thumbnail img").length === 9');
  assert.equal(await read('document.querySelectorAll(".message-image-gallery-item:not([hidden])").length'), 1);
  const stage = await read(`(() => {const r=document.querySelector('.message-image-gallery-stage').getBoundingClientRect();return {width:r.width,height:r.height,top:r.top}})()`);
  await read('document.querySelectorAll(".message-image-gallery-thumbnail")[1].click()');
  await until('document.querySelector(".message-image-gallery-item:not([hidden]) img")?.naturalWidth === 1600');
  assert.deepEqual(await read(`(() => {const r=document.querySelector('.message-image-gallery-stage').getBoundingClientRect();return {width:r.width,height:r.height,top:r.top}})()`), stage,
    'switching portrait/landscape images keeps the gallery and reading position stable');
  await read('document.querySelectorAll(".message-image-gallery-thumbnail")[1].dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))');
  await until('document.querySelectorAll(".message-image-gallery-thumbnail")[8].getAttribute("aria-pressed")==="true"');
  assert.equal(await read('document.querySelector(".message-image-gallery-rail").scrollTop>0'), true, 'keyboard selection scrolls the thumbnail rail');
  assert.equal(await read('document.querySelector(".message-image-gallery-stage").getBoundingClientRect().top'), stage.top, 'rail scrolling does not scroll the conversation');
  await read('document.querySelector(".message-image-gallery-item:not([hidden]) img").click()');
  await until('document.querySelector(".image-preview-canvas img")?.naturalWidth === 900');
  assert.equal(await read('document.querySelector(".image-preview-canvas img").getBoundingClientRect().width>360'), true, 'opening the original is not constrained by the compact preview');
  await read('document.querySelector(".image-preview-close").click()');
  await until('!document.querySelector(".image-preview-dialog")');
  await read(`fixtureMessageOverrides={...fixtureMessageOverrides,content:${JSON.stringify(gallery + '\n\nAppended explanation.')}};renderFixture(false)`);
  await until('document.body.innerText.includes("Appended explanation.")');
  assert.equal(await read('document.querySelectorAll(".message-image-gallery-thumbnail")[8].getAttribute("aria-pressed")'), 'true', 'appending text retains selection');
  await read(`fixtureMessageOverrides={...fixtureMessageOverrides,content:${JSON.stringify('Introduction.\n\n' + gallery)}};renderFixture(false)`);
  await until('document.body.innerText.includes("Introduction.")');
  await read('document.querySelectorAll(".message-image-gallery-thumbnail")[8].dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');
  await frame();
  assert.equal(await read('document.querySelector(".message-image-gallery-rail").scrollTop'), 0, 'Home reveals the first thumbnail even when prose precedes the gallery');
  await read('document.querySelectorAll(".message-image-gallery-thumbnail")[0].dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))');
  await frame();
  assert.equal(await read('document.querySelectorAll(".message-image-gallery-thumbnail")[8].getBoundingClientRect().bottom<=document.querySelector(".message-image-gallery-rail").getBoundingClientRect().bottom+1'), true, 'End fully reveals the selected thumbnail below an introduction');
  for (const theme of ['theme-dark', 'theme-bright']) {
    await read(`document.querySelector('.app').className='app ${theme}'`);
    await frame(); win.webContents.invalidate();
    writeFileSync(resolve(`tmp/message-image-gallery-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await win.setContentSize(430, 720); await frame();
  assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true, 'the gallery fits narrow split panes');

  const separate = `${single}\n\nExplanation.\n\n![wide](${images[1]})\n\n![video](C:/fixture/movie.mp4)\n\n${single}`;
  await read(`fixtureMessageOverrides={...fixtureMessageOverrides,content:${JSON.stringify(separate)}};renderFixture(false)`);
  await until('!!document.querySelector(".assistant-final-answer video")');
  assert.equal(await read('document.querySelectorAll(".message-image-gallery").length'), 0, 'prose and media players separate image groups');
  const refImages = `![first][one] ![second][two]\n\n[one]: ${images[0]}\n[two]: ${images[1]}`;
  await read(`fixtureMessageOverrides={...fixtureMessageOverrides,content:${JSON.stringify(refImages)}};renderFixture(false)`);
  await until('document.querySelectorAll(".message-image-gallery-thumbnail").length === 2');

  await read(`fixtureMessageOverrides={...fixtureMessageOverrides,content:'C:/fixture/apple.png\\n\\nC:/fixture/second.png\\n\\nText.\\n\\nC:/fixture/third.png'};renderFixture(false)`);
  await until('document.querySelectorAll(".message-image-gallery-thumbnail img").length === 2');
  assert.equal(await read('document.querySelectorAll(".message-image-gallery:not(.is-ungrouped)").length'), 1, 'only the consecutive pair shares a gallery');
  assert.equal(await read('document.querySelectorAll(".message-image-gallery.is-ungrouped img").length'), 1, 'the path after intervening text remains separate');

  // File memos keep their session/turn resolution; remote previews share one
  // fetched blob between the stage and thumbnail, including selection changes.
  await read(`clearFixture();fixtureMemoFiles={
    'cardbush-memo:s/t/first':{path:'/srv/first.png',name:'first.png'},
    'cardbush-memo:s/t/second':{path:'/srv/second.png',name:'second.png'}
  };remoteReads=[];remoteCommands=[];remoteContent='![First](cardbush-memo:s/t/first)\\n\\n![Second](cardbush-memo:s/t/second)';renderRemoteFixture(false)`);
  await until('document.querySelectorAll(".message-image-gallery-thumbnail img").length === 2');
  assert.deepEqual(await read('remoteReads.slice().sort()'), ['/srv/first.png', '/srv/second.png']);
  assert.equal(await read('remoteCommands.filter(c=>c.payload.reference).every(c=>c.payload.sessionId==="s"&&c.payload.turnId==="t")'), true, 'gallery memos retain their original scope');
  await read('document.querySelectorAll(".message-image-gallery-thumbnail")[1].click();renderRemoteFixture(false)');
  await frame();
  assert.equal(await read('remoteReads.length'), 2, 'switching and rerendering do not fetch image bytes again');
  await read('document.querySelector(".message-image-gallery-item:not([hidden]) img").click()');
  assert.equal(await read('openedRemoteFiles.at(-1)'), '/srv/second.png', 'remote images open through their own host');
  await read(`fixtureMemoFiles['cardbush-memo:s/t/document']={path:'/srv/report.pdf',name:'report.pdf'};
    remoteContent='![First](cardbush-memo:s/t/first)\\n\\n![Document](cardbush-memo:s/t/document)';renderRemoteFixture(false)`);
  await until('!!document.querySelector(".message-image-gallery.is-ungrouped")');
  assert.equal(await read('remoteReads.includes("/srv/report.pdf")'), false, 'a document memo never becomes an image byte read');
  assert.equal(await read('document.querySelectorAll(".message-image-gallery-item:not([hidden])").length'), 2, 'nonimage memo fallback preserves both authored references');
  console.log('Image gallery UI passed: compact previews, grouped Markdown/paths, stable switching, keyboard rail, originals, narrow/light/dark layouts and scoped remote memos.');
  await read('clearFixture();fixtureMemoFiles={};fixtureMessageOverrides=undefined;remoteContent=null;remoteReads=[];remoteCommands=[];openedRemoteFiles=[];fixtureContent=null;mediaOnly=false;renderFixture(true)');
  await win.setContentSize(880, 720);
};
