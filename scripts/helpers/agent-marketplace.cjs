const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, win, root }) => {
  await run(`(() => {
    window.marketSources={a:[{id:'builtin',kind:'local',location:'/srv/a/bundled/plugins',builtin:true}],b:[{id:'builtin',kind:'local',location:'/srv/b/bundled/plugins',builtin:true}]};
    window.marketApps={a:{revision:1,serviceEnabled:true,plugins:[]},b:{revision:1,serviceEnabled:true,plugins:[]}};
    window.localMarketCalls=[];window.marketInstalls=0;window.marketEvents=[];
    addEventListener('cardbush:agent-settings-updated',event=>marketEvents.push(event.detail));
    for(const key of ['pluginMarketSources','pluginMarketCatalog','addPluginMarket','addLocalPluginMarket','removePluginMarket','previewMarketPlugin','installMarketPlugin','pluginMarketPresentation'])cardbushDesktop[key]=()=>{localMarketCalls.push(key);throw Error('Must not call desktop marketplace')};
    const connect=cardbushDesktop.agents.connect, call=cardbushDesktop.agents.call;
    cardbushDesktop.agents.connect=async id=>{const info=await connect(id);info.capabilities.pluginMarketplace=id!=='c';return info};
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(operation==='mcp.list'){calls.push({id,operation,input});return {configuration:{revision:1,servers:[]},runtime:null}}
      if(operation==='product.command'&&input.kind==='mcp.get')return {revision:1,servers:[]};
      if(operation==='product.command'&&input.kind==='apps.get')return structuredClone(marketApps[id]??{revision:1,serviceEnabled:true,plugins:[]});
      if(operation==='product.command'&&input.kind==='apps.update'){
        calls.push({id,operation,input});const apps=marketApps[id];apps.revision++;apps.plugins=apps.plugins.map(p=>({...p,...input.config.plugins.find(v=>v.id===p.id)}));return structuredClone(apps);
      }
      if(operation==='plugins.marketplace'){
        calls.push({id,operation,input});
        if(input.action==='sources')return structuredClone(marketSources[id]);
        if(input.action==='add'||input.action==='addLocal'){
          const source={id:'source-'+id,kind:input.action==='add'?'github':'local',location:input.source??input.directory};marketSources[id].push(source);return source;
        }
        if(input.action==='remove'){marketSources[id]=marketSources[id].filter(s=>s.id!==input.sourceId);return null}
        if(input.action==='catalog')return {source:marketSources[id].find(s=>s.id===input.sourceId),name:'fixture',displayName:'Agent '+id+' market',fetchedAt:'2026-09-24',entries:input.sourceId==='builtin'?[]:[{name:'cloud-fixture',description:'Cloud plugin fixture',available:true}]};
        if(input.action==='presentation')return {displayName:'Cloud plugin fixture',description:'Only on '+id,logo:'',logoDark:''};
        if(input.action==='preview')return {token:'preview-'+id,id:'cloud-fixture',name:'Cloud plugin fixture',description:'Remote fixture',version:'1.0.0',developerName:'Fixture',source:'fixture/market',revision:'local',format:'openai',updating:false,requirements:['node'],issues:[],components:[{kind:'skill',name:'greet',description:'Greeting skill'}]};
        if(input.action==='install'){
          if(input.token!=='preview-'+id)throw Error('Wrong target');marketInstalls++;
          marketApps[id].plugins=[{id:'cloud-fixture',name:'Cloud plugin fixture',description:'Remote fixture',version:'1.0.0',source:'user',installed:true,enabled:false,config:{},components:[]}];
          return {id:'cloud-fixture',path:'/srv/'+id+'/plugins/cloud-fixture'};
        }
      }
      return call(id,operation,input);
    };
    openFixtureSettings('a');
  })();`);
  const click = async (selector, text) => run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click();undefined;`);
  const field = async (label, value) => {
    await run(`var input=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
    await pause(20);
  };
  await until("!!document.querySelector('.plugin-hub-tabs')", 'shared plugin management opens for Agent A');
  await click('.plugin-hub-tabs button', '市场');
  await until("!!document.querySelector('.plugin-market-grid')&&!document.querySelector('.plugin-market-progress')", 'shared marketplace is available remotely');
  await click('.plugin-market-heading button', '添加来源');
  assert.equal(await run("!!document.querySelector('[aria-label=\"Agent 主机上的市场目录\"]')"), true);
  assert.equal(await run("[...document.querySelectorAll('.plugin-market-source-form button')].some(b=>b.textContent==='本地市场')"), false);
  await field('市场仓库地址', 'pycode4micro/cardbush-plugins');
  await run("document.querySelector('.plugin-market-add').requestSubmit();undefined;");
  await until("document.querySelector('.plugin-market-card-copy')?.textContent.includes('Cloud plugin fixture')", 'remote source loads presentation through the Agent');
  await run("document.querySelector('.plugin-featured-main').click();undefined;");
  await until("document.querySelector('.plugin-market-detail')?.textContent.includes('需要 Agent 主机可运行')", 'preview clearly identifies host requirements');
  await click('.plugin-detail-primary', '安装并启用');
  await until("document.querySelector('.plugin-detail-primary')?.textContent.includes('已安装')", 'installation and shared activation finish');
  assert.equal(await run('marketInstalls'), 1);
  assert.equal(await run('marketApps.a.plugins[0].enabled'), true);
  assert.equal(await run('marketApps.b.plugins.length'), 0);
  assert.ok(await run("marketEvents.includes('a')"));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  await pause(100);
  fs.writeFileSync(path.join(root, 'tmp/agent-marketplace-ui.png'), (await win.webContents.capturePage()).toPNG());
  await click('.plugin-market-page > .plugin-back', '返回市场');
  await click('.plugin-market-page > .plugin-back', '返回插件');
  await until("document.querySelector('.plugin-hub')?.textContent.includes('Cloud plugin fixture')", 'installed plugin appears in shared catalog');
  await run("openFixtureSettings('b');undefined;");
  await until("document.querySelector('.plugin-hub')&&!document.querySelector('.plugin-hub')?.textContent.includes('Cloud plugin fixture')", 'switching hosts clears prior plugin state');
  await click('.plugin-hub-tabs button', '市场');
  await until("document.querySelector('select[aria-label=\"选择插件市场\"]')?.options.length===1&&!document.querySelector('.plugin-market-progress')", 'Agent B does not inherit A sources');
  await click('.plugin-market-heading button', '添加来源');
  await field('Agent 主机上的市场目录', '/srv/b/market');
  await run("document.querySelectorAll('.plugin-market-add')[1].requestSubmit();undefined;");
  await until("calls.some(c=>c.id==='b'&&c.operation==='plugins.marketplace'&&c.input.action==='addLocal'&&c.input.directory==='/srv/b/market')", 'server directory is sent to the selected host');
  await run("(async()=>{connections.push({id:'c',name:'Legacy Agent',transport:'http',url:'https://c.invalid',hasToken:true,connected:false});await refreshAgentConnections();openFixtureSettings('c');})();");
  await until("!!document.querySelector('.plugin-hub-tabs')", 'legacy Agent settings load');
  await click('.plugin-hub-tabs button', '市场');
  await until("document.querySelector('.plugin-market-error')?.textContent.includes('请更新此 Agent 服务')", 'older Agent offers explicit service update guidance');
  assert.deepEqual(await run('localMarketCalls'), []);
  assert.equal(await run("calls.some(c=>c.id==='c'&&c.operation==='plugins.marketplace')"), false);
};
