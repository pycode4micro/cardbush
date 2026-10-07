const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ window, original, origin, read, waitFor, activeReady, pause, click }) => {
  const active = '.right-inspector-tab-page.active ';
  const search = active + '.inspector-bookmark-search input';
  const typeSearch = async value => read(`(()=>{const input=document.querySelector(${JSON.stringify(search)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const count = () => read(`document.querySelectorAll('${active}.inspector-bookmark-link').length`);
  await original.loadURL(origin + '/tab-design'); await activeReady();
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.faviconUrl===${JSON.stringify(origin + '/site-logo.svg')}`, 'native page favicon reaches the tab');
  await waitFor(`document.querySelector('.right-inspector-tab.active .browser-site-icon img')?.naturalWidth>0`, 'website logo renders');
  await original.executeJavaScript(`document.querySelector('link[rel=icon]').href='/site-logo-alt.svg'; void 0`);
  await waitFor(`document.querySelector('.right-inspector-tab.active .browser-site-icon img')?.src===${JSON.stringify(origin + '/site-logo-alt.svg')}`, 'favicon changes on the current page');
  assert.match(await read(`document.querySelector('.right-inspector-tab.active [role=tab]').title`), /品牌工作台 · 商品与成交数据/);

  const bookmarks = Array.from({ length: 55 }, (_, i) => ({
    title: `${i === 0 ? '品牌工作台 · 商品与成交数据' : `常用网站 ${String(i).padStart(2, '0')}`} — 完整收藏名称`,
    url: `${origin}/bookmark-${i}`, folder: i === 40 ? '每月报表' : '工作收藏夹 / 数据与运营',
  }));
  await read(`browserFixture.importBrowserBookmarks(${JSON.stringify(bookmarks)}); void 0`);
  for (let i = 0; i < 2; i++) {
    await read(`document.querySelector('.right-inspector-new-tab').click(); void 0`); await activeReady();
  }
  const newTabId = await read('browserFixture.activeId');
  await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-link').length===24`);
  assert.equal(await read(`document.querySelector('.right-inspector-tab.active .browser-site-icon img')`), null, 'blank tabs do not reuse a previous page icon');
  await waitFor(`document.querySelector('${active}.inspector-bookmark-link .browser-site-icon img')?.naturalWidth>0`, 'bookmarks reuse the visited site logo');
  assert.equal(await read(`document.querySelector('${active}.inspector-bookmark-link .browser-site-icon img').src`), origin + '/site-logo-alt.svg');
  const layout = await read(`(()=>{const top=document.querySelector('${active}.inspector-start-bookmarks').getBoundingClientRect();const collection=document.querySelector('${active}.inspector-bookmark-library').getBoundingClientRect();return {top:top.bottom,collection:collection.top,width:collection.width};})()`);
  assert.ok(layout.collection > layout.top && layout.width > 400, 'collection appears below the existing shortcuts');
  const noOverflow = () => read(`(()=>{const page=document.querySelector('${active}.inspector-new-tab-page');return page.scrollWidth<=page.clientWidth;})()`);
  assert.ok(await noOverflow(), 'many shortcuts never push the bookmark grid outside the new tab');
  const sizes = await read(`Array.from(document.querySelectorAll('.right-inspector-tab')).map(tab=>tab.getBoundingClientRect().width)`);
  assert.ok(sizes.every(width => width > 200 && width <= 249), `three tabs use available title space: ${sizes}`);

  for (const theme of ['bright', 'dark']) {
    await read(`document.querySelector('.app').className='app theme-${theme}'; void 0`);
    await read(`document.querySelector('${active}.inspector-new-tab-page').scrollTop=160; void 0`);
    await pause(160);
    await fs.mkdir(path.resolve('tmp'), { recursive: true });
    await fs.writeFile(path.resolve('tmp', `browser-chrome-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await read(`document.querySelector('${active}.inspector-bookmarks-more').click(); void 0`);
  await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-link').length===48`);
  await typeSearch('每月报表'); await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-link').length===1`);
  assert.match(await read(`document.querySelector('${active}.inspector-bookmark-link').title`), /bookmark-40/);
  await typeSearch('no-such-bookmark'); await waitFor(`document.querySelector('${active}.inspector-bookmarks-empty')!==null`);
  assert.equal(await count(), 0);
  await typeSearch(''); await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-link').length===24`);
  await read(`browserFixture.setWidth(380); void 0`); await pause(350);
  assert.ok(await noOverflow(), 'bookmark cards fit a narrow browser pane');
  await read(`browserFixture.setWidth(820); void 0`); await pause(350);

  // Use a real pointer on a bookmark outside the old first-12 shortcut range.
  await typeSearch('bookmark-40'); await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-link').length===1`);
  await read(`document.querySelector('${active}.inspector-bookmark-link').scrollIntoView({block:'center'}); void 0`);
  await pause(80);
  const guestId = await read(`document.querySelector('${active}webview').getWebContentsId()`);
  await click(window.webContents, active + '.inspector-bookmark-link');
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin + '/bookmark-40')}`); await activeReady();
  assert.equal(await read('browserFixture.activeId'), newTabId, 'bookmark navigates the chosen tab');
  assert.equal(await read(`document.querySelector('${active}webview').getWebContentsId()`), guestId, 'bookmark navigation reuses the live browser');

  await read(`browserFixture.setWidth(380); void 0`); await pause(350);
  await waitFor(`(()=>{const strip=document.querySelector('.right-inspector-tabs');const tab=document.querySelector('.right-inspector-tab.active').getBoundingClientRect();const r=strip.getBoundingClientRect();return strip.scrollWidth>strip.clientWidth&&tab.left>=r.left-1&&tab.right<=r.right+1;})()`, 'narrow pane scrolls to the active tab');
  const narrow = await read(`(()=>{const strip=document.querySelector('.right-inspector-tabs');const plus=document.querySelector('.right-inspector-new-tab').getBoundingClientRect();return {min:Math.min(...Array.from(strip.children).map(tab=>tab.getBoundingClientRect().width)),right:plus.right,width:innerWidth};})()`);
  assert.ok(narrow.min >= 148 && narrow.right < narrow.width, 'tabs remain readable and the new-tab button stays visible');
  console.log('Browser appearance passed: native favicon updates, remembered bookmark logos, wider titles, 55-bookmark search/paging, direct navigation, narrow active-tab reveal, and light/dark rendering.');
};
