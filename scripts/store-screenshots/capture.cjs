const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');

const [profile, output, locale] = process.argv.slice(2);
const demo = require('./demo.json')[locale];
const language = locale.split('-')[0];
const root = path.resolve(__dirname, '../..');
app.setPath('appData', profile);
app.setPath('userData', profile);
app.setAppPath(root);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
for (const name of ['desktop', 'documents', 'downloads', 'pictures']) {
  const folder = path.join(profile, name);
  fs.mkdirSync(folder, { recursive: true });
  app.setPath(name, folder);
}
async function capture() {
  const at = '2026-11-12T07:30:00.000Z';
  const dir = path.join(profile, 'runtime-state');
  const friends = path.join(dir, 'friends');
  fs.mkdirSync(friends, { recursive: true });
  const events = demo.titles.map((title, index) => ({
    id: 'coast-' + index, logicalKey: 'coast-' + index, origin: 'user', title, intent: title,
    archived: false, revision: 1, createdAt: at, updatedAt: new Date(Date.parse(at) - 60000 * index).toISOString(),
    status: index === 1 ? 'watching' : 'completed', inputs: [],
    ...(index === 0 ? {result: {text: demo.summary, turnId: 'itinerary', createdAt: at},
      presentation: {summary: demo.summary, cover: 'tide', pages: [
        {id:'route', title:demo.page, layout:'facts', items:[{label:demo.detail,text:demo.summary},{label:demo.note,text:demo.gear}]},
      ]}} : {}),
  }));
  fs.writeFileSync(path.join(friends, 'events.json'), JSON.stringify({version:1,events,signals:[],detections:[]}));
  const { ConversationJournal } = await import('../../packages/bush-runtime/dist/conversationJournal.js');
  const journal = new ConversationJournal(path.join(dir, 'conversation-journal'));
  journal.append('personal-assistant', {id:'route-question',role:'user',source:'text',content:demo.request,createdAt:at});
  journal.append('personal-assistant', {id:'route-answer',role:'assistant',source:'page',content:demo.answer,createdAt:at,responseTo:['route-question']});
  require('../../dist-electron/bootstrap.js');
  const until = async (fn, label) => {
    const end = Date.now() + 30000;
    do { const value = await fn(); if (value) return value; await delay(100); } while (Date.now() < end);
    throw Error('Timed out: ' + label);
  };
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'desktop window');
  const read = source => win.webContents.executeJavaScript(source);
  const visible = selector => until(() => read('Boolean(document.querySelector('+JSON.stringify(selector)+')?.checkVisibility())'), selector);
  const click = async selector => { await visible(selector); await read('document.querySelector('+JSON.stringify(selector)+').click();void 0'); };
  const home = '[data-desktop-page="overview"]';
  await visible(home);
  await read('localStorage.setItem("cardbush_language_mode",'+JSON.stringify(language)+');localStorage.setItem("cardbush_theme_mode","light");localStorage.setItem("cardbush_projects",'+JSON.stringify(JSON.stringify([{id:'tide-atlas',title:demo.project,rootPath:'D:\\Studio\\Tide Atlas'}]))+');void 0');
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await loaded;
  const dev = win.webContents.debugger;
  dev.attach('1.3');
  await dev.sendCommand('Emulation.setDeviceMetricsOverride', { width:1440, height:810, deviceScaleFactor:4/3, mobile:false });
  await visible(home);
  await until(() => read('document.querySelector(".desktop-cover")?.innerText.includes('+JSON.stringify(demo.titles[0])+')'), 'featured event');
  fs.mkdirSync(path.join(output, locale), {recursive:true});
  const shot = async name => {
    await read('document.fonts.ready;');
    await delay(650);
    const text = await read('document.body.innerText');
    assert.doesNotMatch(text, /[A-Z]:\\Users\\|store-demo-|sk-[A-Za-z0-9]{15}|CB2\./i);
    if (language === 'en') assert.doesNotMatch(text, /[\u3400-\u9fff]/);
    const frame = await dev.sendCommand('Page.captureScreenshot', {format:'png', fromSurface:true, captureBeyondViewport:true, clip:{x:0,y:0,width:1440,height:810,scale:1}});
    const bytes = Buffer.from(frame.data, 'base64');
    assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)], [1920,1080]);
    fs.writeFileSync(path.join(output,locale,name+'.png'),bytes);
    console.log(locale+'/'+name);
  };
  await shot('01-home');
  await click('[data-nav-section=assistant]');
  await visible('.assistant-view .assistant-message-assistant table');
  await shot('02-assistant');
  await click('[data-nav-section=home]');
  await click('.desktop-cover');
  await visible('.desktop-detail-heading');
  await shot('03-event');
  await click('[data-nav-section=explore]');
  await visible('.desktop-explore .desktop-row');
  await shot('04-explore');
  await require('../helpers/open-home-editor.cjs')(read,visible,click);
  await click('[data-home-action=add]');
  await visible('[data-home-add=web]');
  await shot('05-layout');
  dev.detach();
  app.quit();
}
capture().catch(error => { console.error(error); app.exit(1); });
