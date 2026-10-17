const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ window, original, origin, read, waitFor, activeReady, pause, click, uiService }) => {
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
  await waitFor(`document.querySelector('${active}.inspector-bookmark-entry strong')?.textContent===${JSON.stringify(new URL(origin).host)}`, 'visited site appears without bookmarking its URL');
  assert.equal(await read(`document.querySelectorAll('${active}.inspector-bookmark-entry').length`), 1, '55 bookmarks do not populate frequent sites');
  await uiService.library.visit('https://frequent.example/page', 'Another site');
  await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-entry').length===2`, 'open new tabs update when history changes');
  await uiService.library.clear(true, false);
  await waitFor(`document.querySelector('${active}.inspector-bookmark-entry strong')?.textContent==='Google'`, 'clearing history removes derived frequent sites');
  await original.loadURL(origin + '/tab-design#live-history');
  await waitFor(`document.querySelector('${active}.inspector-bookmark-entry strong')?.textContent===${JSON.stringify(new URL(origin).host)}`, 'actual background browser navigation updates frequent sites');
  await original.executeJavaScript(`document.querySelector('link[rel=icon]').href='/site-logo-alt.svg'; void 0`);
  await waitFor(`document.querySelector('${active}.inspector-bookmark-entry .browser-site-icon img')?.src===${JSON.stringify(origin + '/site-logo-alt.svg')}`, 'frequent sites reuse the latest native favicon');
  for (const theme of ['bright', 'dark']) {
    await read(`document.querySelector('.app').className='app theme-${theme}'; void 0`);
    await pause(160);
    await fs.mkdir(path.resolve('tmp'), { recursive: true });
    await fs.writeFile(path.resolve('tmp', `browser-frequent-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await read(`document.querySelector('${active}[data-site-view=bookmarks]').click(); void 0`);
  await waitFor(`document.querySelectorAll('${active}.inspector-bookmark-link').length===24`);
  assert.equal(await read(`document.querySelector('.right-inspector-tab.active .browser-site-icon img')`), null, 'blank tabs do not reuse a previous page icon');
  await waitFor(`document.querySelector('${active}.inspector-bookmark-link .browser-site-icon img')?.naturalWidth>0`, 'bookmarks reuse the visited site logo');
  assert.equal(await read(`document.querySelector('${active}.inspector-bookmark-link .browser-site-icon img').src`), origin + '/site-logo-alt.svg');
  const layout = await read(`(()=>{const top=document.querySelector('${active}.inspector-start-tools').getBoundingClientRect();const collection=document.querySelector('${active}.inspector-bookmark-library').getBoundingClientRect();return {top:top.bottom,collection:collection.top,width:collection.width};})()`);
  assert.ok(layout.collection > layout.top && layout.width > 400 && layout.width <= 640, 'one bounded site collection sits below compact tools');
  assert.equal(await read(`document.querySelector('${active}.inspector-start-bookmarks')`), null, 'no duplicate bookmark section');
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
  const tabLayout = () => read(`(()=>{
    const strip=document.querySelector('.right-inspector-tabs'), viewport=strip.getBoundingClientRect();
    const tabs=Array.from(strip.children), active=tabs.find(tab=>tab.classList.contains('active'));
    const visible=element=>{const r=element.getBoundingClientRect();return r.width>0&&r.left>=viewport.left-1&&r.right<=viewport.right+1;};
    const plus=document.querySelector('.right-inspector-new-tab').getBoundingClientRect();
    return {overflow:strip.scrollWidth>strip.clientWidth+1,allVisible:tabs.every(visible),activeVisible:visible(active),
      iconsVisible:tabs.every(tab=>visible(tab.querySelector('.browser-site-icon'))),
      widths:tabs.map(tab=>tab.getBoundingClientRect().width),activeCloseVisible:visible(active.querySelector('.right-inspector-tab-close')),
      plusVisible:plus.right<=document.querySelector('.right-inspector').getBoundingClientRect().right,
      plusGap:plus.left-viewport.right,left:strip.scrollLeft};
  })()`);
  const narrow = await tabLayout();
  assert.ok(!narrow.overflow && narrow.allVisible && narrow.iconsVisible, 'three tabs shrink to fit a narrow panel: '+JSON.stringify(narrow));
  assert.ok(narrow.widths.every(width=>width<148) && narrow.activeCloseVisible && narrow.plusVisible, 'compression preserves active close and new-tab actions');
  assert.equal(await read(`document.querySelector('${active}webview').getWebContentsId()`), guestId, 'resizing never recreates the page');

  await read("document.querySelector('.right-inspector-new-tab').click(); browserFixture.setWidth(574); void 0"); await activeReady();
  await pause(350);
  for (const theme of ['bright', 'dark']) {
    await read(`document.querySelector('.app').className='app theme-${theme}'; void 0`); await pause(160);
    const layout = await tabLayout();
    assert.ok(layout.allVisible && !layout.overflow && layout.iconsVisible && layout.plusGap>=0 && layout.plusGap<=8, 'four tabs and add button fit together: '+JSON.stringify(layout));
    await fs.writeFile(path.resolve('tmp', `browser-tabs-four-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  // Enough tabs to exercise the icon-only size and then the minimum-width fallback.
  for (let i=0;i<4;i++) {
    await read("document.querySelector('.right-inspector-new-tab').click(); void 0"); await activeReady();
  }
  const crowded = await tabLayout();
  assert.ok(!crowded.overflow && crowded.allVisible && crowded.iconsVisible && crowded.activeCloseVisible, 'eight tabs retain distinct clickable icons: '+JSON.stringify(crowded));
  const hiddenCloses = await read("Array.from(document.querySelectorAll('.right-inspector-tab:not(.active) .right-inspector-tab-close')).every(button=>getComputedStyle(button).display==='none')");
  assert.ok(hiddenCloses, 'narrow inactive tabs use their space for the page instead of a close button');
  await fs.writeFile(path.resolve('tmp', 'browser-tabs-eight.png'), (await window.webContents.capturePage()).toPNG());
  await click(window.webContents, '.right-inspector-tab:first-child [role=tab]'); await activeReady();
  assert.equal(await read(`document.querySelector('${active}webview').getWebContentsId()`), original.id, 'a compressed tab still selects its retained guest');
  await read('browserFixture.setWidth(380); void 0'); await pause(350);
  await click(window.webContents, '.right-inspector-new-tab'); await activeReady();
  const overflow = await tabLayout();
  assert.ok(overflow.overflow && overflow.activeVisible && overflow.activeCloseVisible && overflow.plusVisible, 'only minimum-width overflow scrolls and reveals the active tab: '+JSON.stringify(overflow));
  assert.ok(overflow.widths.every(width=>width>=36), 'overflow never collapses tabs below the clickable minimum');
  await click(window.webContents, '.right-inspector-tab.active .right-inspector-tab-close'); await activeReady();
  assert.equal(await read('browserFixture.tabs.length'), 8, 'compact active close still works');
  await read('browserFixture.setWidth(820); void 0'); await pause(350);
  assert.ok((await tabLayout()).allVisible && (await tabLayout()).left===0, 'growing the panel restores all tabs without stale scroll offset');
  assert.equal(await read('document.documentElement.scrollLeft'),0,'tab reveal never scrolls the application');
  console.log('Browser appearance passed: live history, favicons, bookmark search/navigation, adaptive 3/4/8-tab layouts, compact selection/close, minimum-width overflow, resize restoration, and light/dark rendering.');
};
