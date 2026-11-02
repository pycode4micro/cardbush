const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = async ({win,read,until,pause}) => {
  const origin='https://native-only.example.test';
  await read(`(()=>{const key='cardbush.browser_site_icons.v1';localStorage.setItem(key,JSON.stringify(JSON.parse(localStorage.getItem(key)||'[]').filter(([site])=>!['${origin}','https://dead-icon.example.test'].includes(site))));dispatchEvent(new StorageEvent('storage',{key}));})()`);
  await read(`window.showCachedWebIcons()`);
  await until(`window.iconReads.length===1 && !!document.querySelector('.source-memo-marker')`);
  await read(`document.querySelector('.source-memo-marker').click()`);
  await until(`document.querySelectorAll('.web-link').length===3 && document.querySelectorAll('.web-link .browser-site-icon > svg').length===3`);
  assert.equal(await read('window.iconReads.length'),1,'chat and Source links share one native read');
  await read(`window.iconPending.shift()('')`);
  await until('window.iconReads.length===2');
  assert.deepEqual(await read('window.iconReads[1]'),{url:origin+'/',options:{discover:true}},'fallback discovers public homepage metadata without the private link path');
  const svg='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="10" fill="#2874ab"/><path d="M12 24h24M24 12v24" stroke="white" stroke-width="6"/></svg>').toString('base64');
  await read(`window.iconPending.shift()(${JSON.stringify(svg)})`);
  await until(`Array.from(document.querySelectorAll('.web-link img')).length===3 && Array.from(document.querySelectorAll('.web-link img')).every(i=>i.src.startsWith('data:image/png;') && i.naturalWidth===48)`);
  assert.equal(await read(`document.querySelectorAll('.web-link .browser-site-icon > svg').length`),0,'resolved site images replace every globe, including Source');
  assert.equal(await read('window.iconReads.length'),2,'cached image publication does not trigger a refill loop');
  const saved=await read(`JSON.parse(localStorage.getItem('cardbush.browser_site_icons.v1')).find(([site])=>site===${JSON.stringify(origin)})`);
  assert.ok(saved[2].startsWith('data:image/png;base64,'));
  assert.ok(!JSON.stringify(saved).includes('secret='));
  writeFileSync(resolve('tmp/cached-web-link-icons.png'),(await win.webContents.capturePage()).toPNG());
  // Re-create the whole renderer to exercise persisted data, not just React state.
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.reload(); await loaded; await until(`typeof window.showCachedWebIcons==='function'`);
  await read('window.showCachedWebIcons()');
  await until(`document.querySelectorAll('.web-link img').length===2 && Array.from(document.querySelectorAll('.web-link img')).every(i=>i.src.startsWith('data:image/png;') && i.naturalWidth===48)`);
  assert.equal(await read('window.iconReads.length'),0,'a fresh renderer uses saved PNGs without network/IPC reads');
  await read(`window.showCachedWebIcons('https://dead-icon.example.test')`);
  await until('window.iconReads.length===1'); await read(`window.iconPending.shift()('')`);
  await until('window.iconReads.length===2'); await read(`window.iconPending.shift()('')`); await pause();
  await read('window.showCachedWebIcons()'); await pause();
  await read(`window.showCachedWebIcons('https://dead-icon.example.test')`); await pause();
  assert.equal(await read('window.iconReads.length'),2,'failed sites back off across repeated mounts');
  console.log('Web link icons passed: native recovery, homepage discovery, shared chat/Source reads, SVG-to-PNG cache, offline reload and failure backoff.');
};
