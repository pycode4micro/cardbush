// Real controls with isolated desktop transport/model-policy preparation; no user configuration or network.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), electron = require('electron');
if (typeof electron === 'string') {
  fs.mkdirSync('tmp', { recursive: true }); const directory = fs.mkdtempSync(path.resolve('tmp/webhook-ui-'));
  build(directory).then(() => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
    if (result.error) console.error(result.error); process.exitCode = result.status ?? 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else run();
async function build(directory) {
  const { build } = await import('vite'), { default: react } = await import('@vitejs/plugin-react');
  const file = name => JSON.stringify(path.resolve(name).replaceAll('\\', '/'));
  const result = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react(), {
    name: 'webhook-fixture', enforce: 'pre', resolveId(source, importer) {
      if (source.endsWith('__webhook_fixture__.tsx')) return '\0fixture.tsx';
      if (importer?.endsWith('webhookBinding.ts')) {
        if (source.endsWith('runtimeChat')) return '\0prepare.ts';
        if (source.endsWith('ElectronRuntimeSession')) return '\0runtime.ts';
        if (source.endsWith('assistantBackend')) return '\0assistant.ts';
      }
    }, load(id) {
      if (id === '\0prepare.ts') return `export const prepareRuntimeAgentRequest=async config=>{fixture.prepared.push(config);return {runtimeRequest:{sessionId:config.sessionId,model:config.model,inputMessages:[],metadata:{}}}};`;
      if (id === '\0runtime.ts') return 'export const createDesktopRuntimeSession=()=>({dispose(){fixture.disposed++}});';
      if (id === '\0assistant.ts') return 'export const assistantBackend={ensure:async()=>{},read:async()=>({generation:3})};';
      if (id !== '\0fixture.tsx') return;
      return `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
        import {WebhookConnectionButton} from ${file('src/features/webhooks/WebhookConnectionButton.tsx')};
        import {TopBar} from ${file('src/components/TopBar.tsx')};
        import {uiText} from ${file('src/i18n/index.ts')};
        import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};
        window.fixture={t:uiText,commands:[],prepared:[],disposed:0,connections:[],pairings:[],host:'127.0.0.1',port:4791};
        window.cardbushDesktop={webhooks:{command:async input=>{
          fixture.commands.push(structuredClone(input));
          if(input.action==='approve_pairing'){
            const pending=fixture.pairings.find(p=>p.requestId===input.requestId);fixture.pairings=fixture.pairings.filter(p=>p!==pending);
            fixture.connections.push({id:crypto.randomUUID(),name:pending.name,enabled:true,status:'offline',url:pending.replyUrl,headers:{},parameters:{},body:{},incoming:{},sessionId:input.binding.sessionId,kind:input.binding.kind,token:'fixture-token',endpoint:'http://127.0.0.1:4791/fixture',pending:0});
          }
          if(input.action==='reject_pairing')fixture.pairings=fixture.pairings.filter(p=>p.requestId!==input.requestId);
          if(input.action==='save'){
            if(!input.config.headers||Array.isArray(input.config.headers))throw Error('invalid_parameters');
            const id=input.config.id??crypto.randomUUID();fixture.connections=fixture.connections.filter(c=>c.id!==id);
            fixture.connections.push({...input.config,id,status:input.config.enabled?'offline':'disabled',sessionId:input.binding.sessionId,kind:input.binding.kind,token:'fixture-token',endpoint:'http://127.0.0.1:4791/api/webhooks/v1/'+id+'/messages',pending:0});
          }
          if(input.action==='delete')fixture.connections=fixture.connections.filter(c=>c.id!==input.id);
          if(input.action==='listener'){fixture.host=input.host;fixture.port=input.port;}
          if(input.action==='test')return {delivered:true};
          return {host:fixture.host,port:fixture.port,listening:true,pairings:fixture.pairings,onlineElsewhere:fixture.onlineElsewhere??[],connections:fixture.connections.filter(c=>c.sessionId===(input.sessionId??input.binding?.sessionId))};
        }}};
        Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{fixture.copied=text}}});
        function Fixture(){const [language,setLanguage]=useState('zh'),[theme,setTheme]=useState('dark'),[sessionId,setSession]=useState('existing-chat');
          fixture.language=setLanguage;fixture.theme=setTheme;fixture.session=setSession;
          return <div className={'app theme-'+theme}><section className="chat-panel"><TopBar language={language} title={sessionId}
            connectionControl={<WebhookConnectionButton language={language} title={sessionId} sessionId={sessionId} kind={sessionId==='personal-assistant'?'assistant':'conversation'}
              prepare={async()=>({sessionId,model:'configured-model',userInput:''})}/>}/></section></div>;
        }createRoot(document.getElementById('root')).render(<Fixture/>);`;
    },
  }], build: { write: false, minify: false, lib: { entry: path.resolve('src/__webhook_fixture__.tsx'), name: 'WebhookFixture', formats: ['iife'] } } });
  const output = (Array.isArray(result) ? result[0] : result).output;
  fs.writeFileSync(path.join(directory, 'index.html'), `<html><meta charset="utf-8"><style>${output.filter(i => i.type === 'asset' && i.fileName.endsWith('.css')).map(i => i.source).join('\n')} .app{width:100%;height:100vh}.chat-panel{width:100%}</style><div id="root"></div><script>${output.find(i => i.type === 'chunk').code.replaceAll('</script', '<\\/script')}</script></html>`);
}
function run() {
  const { app, BrowserWindow } = electron, directory = process.argv[2]; app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const timeout = setTimeout(() => app.exit(1), 55000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 980, height: 800, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
    const read = code => win.webContents.executeJavaScript(code), pause = ms => new Promise(r => setTimeout(r, ms));
    const until = async code => { for (let n = 0; n < 120; n++) { if (await read(code)) return; await pause(25); } throw Error(code+'\n'+await read('document.body.innerText')); };
    const click = selector => read(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
    const fill = (name, value) => read(`(()=>{const n=document.querySelector('[name="${name}"]');Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const button = key => read(`Array.from(document.querySelectorAll('.webhook-dialog button')).find(b=>b.textContent.trim()===fixture.t(document.documentElement.lang||'zh')(${JSON.stringify(key)})).click();void 0`);
    try {
      await win.loadFile(path.join(directory, 'index.html')); await until('!!document.querySelector("[data-webhook-connect]")');
      assert.equal(await read('document.querySelector("[data-webhook-connect]").disabled'), false);
      await click('[data-webhook-connect]'); await until('!!document.querySelector(".webhook-empty")');
      assert.equal(await read('document.querySelectorAll(".webhook-dialog input,.webhook-dialog textarea").length'), 0, 'first connection requires no address/token form');
      await read("fixture.onlineElsewhere=[{id:'wx',name:'Weixin',contextTitle:'Assistant'},{id:'fs',name:'Feishu',contextTitle:'Product research'}];void 0");
      await until('document.querySelectorAll("[data-bound-elsewhere]").length===2');
      assert.deepEqual(await read('Array.from(document.querySelectorAll("[data-bound-elsewhere] span"),node=>node.textContent)'), ['Assistant','Product research']);
      assert.equal(await read('!!document.querySelector(".webhook-empty,[data-bound-elsewhere] button")'), false);
      await read("fixture.onlineElsewhere=[];fixture.pairings=[{requestId:crypto.randomUUID(),name:'Local Bot',replyUrl:'http://127.0.0.1:4792/reply'}];void 0");
      await until('!!document.querySelector("[data-pairing]")');
      assert.equal(await read('fixture.prepared.length'), 0, 'discovery does not prepare a model or export context');
      fs.writeFileSync(path.join(directory, 'quick-connect-dark.png'), (await win.webContents.capturePage()).toPNG());
      await click('.webhook-pair-action'); await until('!!document.querySelector("[data-connection]")');
      assert.equal(await read('fixture.commands.find(c=>c.action==="approve_pairing").binding.sessionId'), 'existing-chat');
      assert.equal(await read('fixture.connections.length'), 1);
      assert.equal(await read('fixture.prepared[0].permissionMode'), 'all_free');
      assert.equal(await read('fixture.prepared[0].interactiveRequestsEnabled'), false);
      await until('document.querySelector("[data-connection] [role=status]").textContent===fixture.t("zh")("webhook.offline")');
      assert.equal(await read('document.querySelector(".webhook-service-list h3").textContent'), await read('fixture.t("zh")("webhook.savedServices")'));
      await read("fixture.connections[0].status='connected';void 0");
      await until('document.querySelector("[data-connection] [role=status]").textContent===fixture.t("zh")("webhook.connected")');
      await read("fixture.connections[0].status='offline';void 0");
      await until('document.querySelector("[data-connection] [role=status]").textContent===fixture.t("zh")("webhook.offline")');
      assert.equal(await read('fixture.connections[0].enabled'), true, 'disconnect must not disable or remove saved configuration');
      await read("fixture.connections[0].name='A saved service with a very long descriptive name';void 0");
      await until('document.querySelector("[data-connection] strong").textContent===fixture.connections[0].name');
      for (const [language,theme] of [['zh','dark'],['en','bright']]) {
        win.setContentSize(390,740); await read(`fixture.language('${language}');fixture.theme('${theme}');document.documentElement.lang='${language}';void 0`); await pause(100);
        assert.equal(await read('document.querySelector(".settings-dialog-body").scrollWidth<=document.querySelector(".settings-dialog-body").clientWidth'), true);
        assert.equal(await read(`document.querySelector('[data-connection] [role=status]').textContent===fixture.t('${language}')('webhook.offline')`), true);
        fs.writeFileSync(path.join(directory, `quick-connected-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await read("fixture.language('zh');fixture.theme('dark');document.documentElement.lang='zh';void 0");
      await read("fixture.connections[0].enabled=false;fixture.connections[0].status='disabled';void 0");
      await until('document.querySelector("[data-connection] [role=status]").textContent===fixture.t("zh")("webhook.disabled")');
      await button('webhook.delete'); await until('!document.querySelector("[data-connection]")');
      await read('fixture.prepared=[];fixture.disposed=0;fixture.commands=[];void 0'); win.setContentSize(980,800);
      await button('webhook.manual'); await until('!!document.querySelector(".webhook-dialog fieldset:not(:disabled)")');
      assert.ok(await read('document.querySelector(".settings-dialog-header").textContent.includes("existing-chat")'));
      await fill('webhook-name', 'My bot'); await fill('webhook-url', 'https://bot.example/reply');
      await click('.webhook-dialog details summary'); await fill('webhook-headers', '{"Authorization":"Bearer custom"}');
      await fill('webhook-parameters', '{"room":"my-room"}');
      await fill('webhook-body', '{"text":"{{reply}}","room":"{{parameters.room}}","sequence":"{{sequence}}"}');
      await fill('webhook-mapping', '{"messageId":"event.id","text":"event.content","senderId":"sender","conversationId":"room"}');
      await button('webhook.save'); await until('!!document.querySelector(".webhook-endpoint")');
      assert.equal(await read('document.querySelector(".webhook-endpoint .webhook-status").textContent'), await read('fixture.t("zh")("webhook.offline")'));
      const saved = await read('fixture.commands.find(c=>c.action==="save")');
      assert.equal(saved.binding.sessionId, 'existing-chat'); assert.equal(saved.binding.parent.model, 'configured-model');
      assert.equal(saved.config.parameters.room, 'my-room'); assert.equal(saved.config.incoming.text, 'event.content');
      assert.equal(await read('fixture.disposed'), 1);
      await click('.webhook-endpoint > label:last-of-type button'); await until('!!fixture.copied');
      assert.equal(await read('fixture.copied'), 'fixture-token');
      await button('webhook.test'); await until('fixture.commands.some(c=>c.action==="test")');
      await until('document.querySelector(".webhook-dialog").getAttribute("aria-busy")==="false"');
      await fill('webhook-headers', '{bad'); await button('webhook.save'); await until('!!document.querySelector(".webhook-error")');
      assert.equal(await read('fixture.commands.filter(c=>c.action==="save").length'), 1, 'invalid JSON never reaches desktop host');
      await fill('webhook-headers', '{}');
      await button('webhook.save'); await until('fixture.commands.filter(c=>c.action==="save").length===2 && document.querySelector(".webhook-dialog").getAttribute("aria-busy")==="false"');
      await click('.webhook-dialog details summary');
      await pause(100);
      assert.equal(await read('!document.querySelector(".webhook-dialog details").open && !document.querySelector("[name=webhook-headers]").checkVisibility()'), true, 'advanced fields stay collapsed by default');
      fs.writeFileSync(path.join(directory, 'desktop-dark.png'), (await win.webContents.capturePage()).toPNG());
      for (const language of ['zh', 'en']) for (const theme of ['dark', 'bright']) {
        win.setContentSize(390, 740);
        await read(`fixture.language('${language}');fixture.theme('${theme}');document.documentElement.lang='${language}';void 0`); await pause(100);
        assert.equal(await read(`document.querySelector('[data-webhook-connect]').getAttribute('aria-label')===fixture.t('${language}')('webhook.open')`), true);
        assert.equal(await read(`(()=>{const d=document.querySelector('.webhook-dialog').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight&&document.querySelector('.settings-dialog-body').scrollWidth<=document.querySelector('.settings-dialog-body').clientWidth})()`), true, 'dialog fits narrow viewport');
        fs.writeFileSync(path.join(directory, `${language}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await read("fixture.session('personal-assistant');void 0"); await until('!document.querySelector(".webhook-dialog")');
      await click('[data-webhook-connect]'); await until('!!document.querySelector(".webhook-quick-dialog")'); await button('webhook.manual');
      await until('!!document.querySelector(".webhook-dialog fieldset:not(:disabled)")');
      assert.equal(await read('!!document.querySelector(".webhook-endpoint")'), false, 'connection list is scoped to current context');
      await button('webhook.save'); await until('!!document.querySelector(".webhook-endpoint")');
      assert.equal(await read('fixture.commands.filter(c=>c.action==="save").at(-1).binding.generation'), 3);
      await click('.webhook-toggle input'); await button('webhook.save'); await until('fixture.connections.find(c=>c.kind==="assistant")?.enabled===false');
      await until('document.querySelector(".webhook-dialog").getAttribute("aria-busy")==="false"');
      await button('webhook.delete'); await until('!document.querySelector(".webhook-endpoint")');
      assert.equal(await read('fixture.connections.length'), 1, 'deleting Assistant connection preserves ordinary connection');
      assert.deepEqual(errors, []);
      console.log('Webhook UI passed: existing context/model, custom fields, copy, test, invalid JSON, disable/delete, context switch, language and narrow themes. Screenshots: '+directory);
    } finally { win.destroy(); clearTimeout(timeout); }
  }).then(() => app.exit(0)).catch(e => { console.error(e); app.exit(1); });
}
