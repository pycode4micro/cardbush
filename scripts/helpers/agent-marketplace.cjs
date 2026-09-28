const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, win, root }) => {
  await run(`(() => {
    window.marketSources=[{id:'builtin',kind:'local',location:'C:/shared/bundled/plugins',builtin:true}];
    window.marketApps={revision:1,serviceEnabled:true,plugins:[]};window.marketInstalls=0;window.localMarketCalls=[];
    fixtureSettingsHost.fetchCardbushAppsConfiguration=async()=>structuredClone(marketApps);
    fixtureSettingsHost.saveCardbushAppsConfiguration=async config=>{marketApps=structuredClone(config);marketApps.revision++;return marketApps;};
    fixtureSettingsHost.fetchMcpConnectionOverview=async()=>({revision:1,servers:[],snapshot:null});
    Object.assign(cardbushDesktop,{
      pluginMarketSources:async()=>structuredClone(marketSources),
      addPluginMarket:async source=>{localMarketCalls.push(source);const value={id:'shared-source',kind:'github',location:source};marketSources.push(value);return value;},
      addLocalPluginMarket:async()=>null,
      pluginMarketCatalog:async sourceId=>({source:marketSources.find(s=>s.id===sourceId),name:'fixture',displayName:'Shared market',fetchedAt:'2026-09-24',entries:sourceId==='builtin'?[]:[{name:'shared-fixture',description:'Shared plugin fixture',available:true}]}),
      pluginMarketPresentation:async()=>({displayName:'Shared plugin fixture',description:'Shared by local and cloud',logo:'',logoDark:''}),
      previewMarketPlugin:async()=>({token:'shared-preview',id:'shared-fixture',name:'Shared plugin fixture',description:'Shared fixture',version:'1.0.0',developerName:'Fixture',source:'fixture/market',revision:'local',format:'openai',updating:false,requirements:['node'],issues:[],components:[{kind:'skill',name:'greet',description:'Greeting skill'}]}),
      installMarketPlugin:async token=>{if(token!=='shared-preview')throw Error('Wrong preview');marketInstalls++;marketApps.plugins=[{id:'shared-fixture',name:'Shared plugin fixture',description:'Shared fixture',version:'1.0.0',source:'user',installed:true,enabled:false,config:{},components:[]}];return {id:'shared-fixture',path:'C:/shared/plugins/shared-fixture'};},
    });
    openFixtureSettings('a');
  })();`);
  const click = async (selector, text) => run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click();undefined;`);
  await until("!!document.querySelector('.plugin-hub-tabs')", 'Agent entry opens shared plugin management');
  assert.equal(await run("!!document.querySelector('.settings-target')"), false);
  await click('.plugin-hub-tabs button', '市场');
  await until("!!document.querySelector('.plugin-market-grid')&&!document.querySelector('.plugin-market-progress')", 'one shared marketplace');
  await click('.plugin-market-heading button', '添加来源');
  assert.equal(await run("!!document.querySelector('[aria-label=\"Agent 主机上的市场目录\"]')"), false);
  await run(`var input=document.querySelector('input[aria-label="市场仓库地址"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'fixture/shared-plugins');input.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
  await pause(20);await run("document.querySelector('.plugin-market-add').requestSubmit();undefined;");
  await until("document.querySelector('.plugin-market-card-copy')?.textContent.includes('Shared plugin fixture')", 'shared source loads');
  await run("document.querySelector('.plugin-featured-main').click();undefined;");
  await until("!!document.querySelector('.plugin-market-detail')", 'shared preview');
  await click('.plugin-detail-primary', '安装并启用');
  await until("document.querySelector('.plugin-detail-primary')?.textContent.includes('已安装')", 'shared installation and activation finish');
  assert.equal(await run('marketInstalls'), 1);assert.equal(await run('marketApps.plugins[0].enabled'), true);
  await click('.plugin-market-page > .plugin-back', '返回市场');
  await click('.plugin-market-page > .plugin-back', '返回插件');
  await until("document.querySelector('.plugin-hub')?.textContent.includes('Shared plugin fixture')", 'installed plugin is in common catalog');
  await run("openFixtureSettings('b');undefined;");
  await until("document.querySelector('.plugin-hub')?.textContent.includes('Shared plugin fixture')", 'another Agent entry keeps the same installed plugins');
  assert.equal(await run("calls.some(c=>c.operation==='plugins.marketplace')"), false, 'settings never install into an independent cloud catalog');
  assert.deepEqual(await run('localMarketCalls'), ['fixture/shared-plugins']);
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });await pause(100);
  fs.writeFileSync(path.join(root, 'tmp/agent-marketplace-ui.png'), (await win.webContents.capturePage()).toPNG());
  console.log('Unified plugin settings passed: shared source, preview, install/enable, persistent catalog across Agent entry points.');
};
