const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

module.exports = async ({root,project,win,read,visible,click,wait}) => {
  const entry = path.join(project,'assets/skills/cardbush-docs/scripts/home-component.mjs');
  const cli = (...args) => JSON.parse(execFileSync('node',[entry,...args,'--profile',root],{encoding:'utf8',windowsHide:true}));
  const html = path.join(root,'index.html'), ts = path.join(root,'main.ts'), css = path.join(root,'main.css');
  fs.writeFileSync(html,'<label><input type="checkbox">Review</label>');
  fs.writeFileSync(css,'input{accent-color:rgb(19, 58, 95)}');
  fs.writeFileSync(ts,`const input = document.querySelector<HTMLInputElement>('input')!; const api = (window as any).cardbush;
    await api.ready; input.checked = (await api.state.read()) === true;
    input.onchange = async () => {await api.state.write(input.checked); input.dataset.saved='true'}; input.dataset.ready='true';`);
  const inputFiles = [html,ts,css].map(file => ({name:path.basename(file),text:fs.readFileSync(file,'utf8')}));
  const assembled = await read('window.cardbushDesktop.assembleHomeComponent(' + JSON.stringify(inputFiles) + ')');
  assert.ok(assembled.includes('type="module"') && !assembled.includes('<HTMLInputElement>') && assembled.includes('accent-color'));
  const options = ['publish','--id','qa-review','--title','Review','--html',html,'--script',ts,'--style',css];
  assert.equal(cli(...options).home,false);
  await click('.home-components > header button');
  const choice = '.home-component-picker button[aria-pressed]';
  await visible(choice);
  await click(choice);
  const card = '.home-components [data-component-id="qa-review"]';
  await visible(card+' iframe');
  assert.equal(cli('list').find(item => item.id === 'qa-review').home,true);
  const guest = () => win.webContents.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc');
  const inFrame = code => guest()?.executeJavaScript(code);
  await wait(() => inFrame('!!document.querySelector("input[data-ready]")'),'TypeScript component mounted');
  assert.equal(await inFrame('getComputedStyle(document.querySelector("input")).accentColor'),'rgb(19, 58, 95)');
  await inFrame('document.querySelector("input").click()');
  await wait(() => inFrame('!!document.querySelector("[data-saved]")'),'component state saved');
  await click(card+' header button:last-child');
  await wait(() => read('document.querySelector(".home-components iframe") === null'),'removed only from home');
  assert.equal(cli('list').find(item => item.id === 'qa-review').home,false);
  assert.equal(cli(...options,'--home').home,true);
  await visible(card+' iframe');
  await wait(() => inFrame('document.querySelector("input[data-ready]")?.checked'),'republished component reopens with saved value');
  await click(card+' header button:last-child');
  await wait(() => read('!document.querySelector(".home-components iframe")'),'only network fixture on Home');
  await verifyNetworkAndPreview({root,project,win,read,visible,click,wait,inFrame});
  if (await read('!!document.querySelector(\'.home-components > header button[aria-expanded="true"]\')')) await click('.home-components > header button');
  await click('.home-components > header button');
  await click('.home-component-picker button:first-child');
  await wait(() => read('document.querySelector(".new-chat-input [data-composer-input]")?.value.includes("cardbush-docs")'),'create in chat pre-fills the request');
  console.log('Home components passed: skill publication, sandboxed TS/CSS interaction, add/remove, retained state and chat authoring entry.');
};

async function verifyNetworkAndPreview({root,project,win,read,visible,click,wait,inFrame}) {
  const {BrowserWindow,nativeImage}=require('electron');
  const library=require(path.join(project,'assets/skills/cardbush-docs/scripts/home-library.cjs')).openLibrary(root);
  const origin='https://scores.example.org';
  const html='<style>html{background:rgb(32,92,197)!important}html.online{background:red!important}</style><script>if(window.cardbush.net)document.documentElement.classList.add("online")</script>';
  const item={id:'qa-scores',title:'Scores',html,width:12,height:320,networkDomains:[origin]};
  try {
    library.publish(item,true);
    const card='.home-components [data-component-id="qa-scores"]';
    await visible(card+' iframe');
    await wait(()=>inFrame('!!window.cardbush'),'sandbox initializes');
    assert.equal(await inFrame('!!cardbush.net'),false);
    await read(`window.fixtureFetch=window.fetch;window.fixtureScoreRequests=[];window.fetch=(url,init)=>{
      if(new URL(url).origin!=='https://scores.example.org')return window.fixtureFetch(url,init);
      window.fixtureScoreRequests.push([init.method,init.credentials,init.redirect,init.referrerPolicy]);
      return Promise.resolve(new Response('{"score":92}',{headers:{'Content-Type':'application/json'}}));};void 0`);
    await click(card+' header button:first-of-type');
    assert.equal(await read('document.querySelector(".component-import fieldset input").checked'),false);
    await click('.component-import fieldset input'); await click('.component-import button[type=submit]');
    await wait(()=>inFrame('!!window.cardbush?.net'),'grant applied in live card');
    assert.deepEqual(await inFrame('cardbush.net.fetchJson("https://scores.example.org/live")'),{score:92});
    assert.deepEqual(await read('window.fixtureScoreRequests'),[['GET','omit','error','no-referrer']]);
    assert.equal(await inFrame('cardbush.net.fetchJson("https://other.example.org/").catch(e=>e.message)'),'CAPABILITY_DENIED');
    assert.equal(await inFrame('fetch("https://scores.example.org/").then(()=>true,()=>false)'),false);
    const before=BrowserWindow.getAllWindows().length;
    const png=await requestPreview(project,library,item);
    const image=nativeImage.createFromBuffer(Buffer.from(png,'base64')); assert.equal(image.isEmpty(),false);
    assert.equal(image.getSize().width>=900,true);
    const pixel=image.toBitmap().subarray(0,3); assert.ok(pixel[0]>pixel[2] && pixel[0]>120,'rendered fixture is blue');
    assert.equal(BrowserWindow.getAllWindows().length,before);
    library.publish({...item,html:'<p>Updated</p>'},true);
    await wait(()=>inFrame('document.body.innerText.trim()==="Updated" && !window.cardbush?.net'),'new code revokes access');
    assert.equal(await read('!!document.querySelector(".html-component-error")'),false);
    await read('window.fetch=window.fixtureFetch;void 0');
    console.log('Widget network and preview passed: explicit per-site grant, scoped JSON, offline screenshot, live revocation.');
  } finally {library.close();}
}

async function requestPreview(project,library,item) {
  const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');
  const {startProductMcpManagement}=await import('../../dist-electron/productMcpManagement.mjs');
  const {previewHomeComponent}=require(path.join(project,'dist-electron/homeComponentPreview.js'));
  const endpoint=await startProductMcpManagement(()=>{throw Error('unrelated management call');},()=>library,previewHomeComponent);
  const client=new Client({name:'widget-preview-test',version:'1'});
  try {
    const transport=new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:'Bearer '+endpoint.token}}});
    await client.connect(transport);
    const result=await client.callTool({name:'preview_home_component',arguments:{id:item.id}});
    assert.notEqual(result.isError,true,result.content[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).sha256,library.describe(item).sha256);
    assert.equal(result.content[1].mimeType,'image/png');
    return result.content[1].data;
  } finally {await client.close();await endpoint.close();}
}
