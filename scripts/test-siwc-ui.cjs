const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { build } = await import('vite');
  const result = await build({ configFile: false, logLevel: 'warn', plugins: [{ name: 'siwc-fixture', enforce: 'pre',
    resolveId: id => id.endsWith('__siwc_test__.ts') ? '\0siwc-fixture' : undefined,
    load: id => id === '\0siwc-fixture' ? ['src/styles/theme.css', 'src/styles/app.css', 'src/styles/appearance.css'].map(file => `import ${JSON.stringify(path.join(root, file))};`).join('\n') + `\nexport * from ${JSON.stringify(path.join(root, 'src/features/settings/ModelsSettingsPanel.tsx'))};` : undefined,
  }], build: { write: false, minify: false, lib: { entry: path.join(root, '__siwc_test__.ts'), formats: ['cjs'] },
    rolldownOptions: { external: /^react(?:-dom)?(?:\/|$)/, output: { codeSplitting: false } } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const bundle = output.find(item => item.type === 'chunk').code;
  const win = new BrowserWindow({ show: false, width: 1100, height: 930, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false, partition: 'siwc-fixture' } });
  const errors = [];
  win.webContents.session.webRequest.onBeforeRequest((details, done) => { const external = /^https?:/.test(details.url); if (external) errors.push(details.url); done({ cancel: external }); });
  const run = code => win.webContents.executeJavaScript(code);
  const until = async code => { for (let i = 0; i < 150; i++) { if (await run(code)) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error(code + '\n' + await run('document.body.innerText')); };
  const click = label => run(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)}).click(); void 0`);
  const choose = async (label, value) => {
    await run(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click(); void 0`);
    await until(`!!document.querySelector('.settings-dropdown-popover:popover-open')`);
    await run(`[...document.querySelectorAll('.settings-dropdown-popover:popover-open [role=option]')].find(option=>option.value===${JSON.stringify(value)}).click(); void 0`);
  };
  try {
    await win.loadURL('data:text/html,<html><body><div class="app theme-dark"><div class="settings-shell"><div class="settings-content"><div id="root"></div></div></div></div></body></html>');
    await win.webContents.insertCSS(output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n'));
    await run(`
      window.failures=[]; addEventListener('error',e=>failures.push(e.message)); addEventListener('unhandledrejection',e=>failures.push(String(e.reason)));
      crypto.randomUUID=require('node:crypto').randomUUID;
      const React=require(${JSON.stringify(require.resolve('react'))}), {createRoot}=require(${JSON.stringify(require.resolve('react-dom/client'))});
      const module={exports:{}}; new Function('require','module','exports',${JSON.stringify(bundle)})(require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))}),module,module.exports);
      const h=React.createElement, reactRoot=createRoot(document.getElementById('root')), View=module.exports.ModelsSettingsPanel;
      window.accountA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; window.accountB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      window.siwc={accounts:[],signingIn:false,welcomePending:false}; const listeners=new Set(); window.notify=()=>listeners.forEach(fn=>fn());
      window.catalogCalls=[]; window.saved=null; window.delayA=false; window.releaseA=null;
      window.cardbushDesktop={siwcSnapshot:async()=>structuredClone(siwc),onAccountsChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        siwcAction:async input=>{if(input.action==='login'){siwc.accounts=[{id:accountA,label:'first@example.test',state:'signed_in',planEnabled:true},{id:accountB,label:'second@example.test',state:'signed_in',planEnabled:true}];siwc.welcomePending=true;}
          if(input.action==='dismiss_welcome')siwc.welcomePending=false;
          if(input.action==='logout')siwc.accounts.find(a=>a.id===input.accountId).state='signed_out'; notify(); return structuredClone(siwc);},
        siwcModels:async id=>{catalogCalls.push(id);if(id===accountA&&delayA)await new Promise(resolve=>releaseA=resolve);return[{id:id===accountA?'gpt-latest-a':'gpt-latest-b',name:id===accountA?'GPT Latest A':'GPT Latest B'}];}};
      window.initial={defaultModelId:'key',models:[{id:'key',modelName:'key-model',provider:'openai',apiKey:'',hasApiKey:true,baseUrl:'',apiProtocol:'openai_responses'}]};
      window.render=(scopeName)=>reactRoot.render(h(View,{language:'zh',models:saved||initial,scopeName,onSave:async value=>{saved=structuredClone(value);return value},onRefresh:async()=>{},visualInputAvailable:true,visualInputEnabled:true,onVisualInputEnabledChange:()=>{}})); render();
    `);
    await until("!![...document.querySelectorAll('button')].find(button=>button.textContent==='添加模型')"); await click('添加模型');
    await until("!!document.querySelector('dialog[open]')"); await choose('授权方式', 'chatgpt'); await click('Continue with ChatGPT');
    await until("document.querySelector('[aria-label=账号可用模型]')?.textContent.includes('选择模型') && catalogCalls.length>0");
    await choose('账号可用模型', 'gpt-latest-a');
    await until("document.querySelector('.model-name-row input').value==='gpt-latest-a' && !document.querySelector('.settings-dropdown-popover:popover-open')");
    assert.equal(await run("document.querySelector('input[type=password]')===null"), true);
    await until("!!document.querySelector('.siwc-welcome')");
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(root, 'tmp/siwc-model-settings.png'), (await win.webContents.capturePage()).toPNG());
    await click('知道了'); await until("!document.querySelector('.siwc-welcome')");
    await click('高级选项');
    assert.equal(await run("document.body.innerText.includes('最大输出 tokens') || document.body.innerText.includes('自定义请求头')"), false);
    await click('保存模型'); await until("!document.querySelector('dialog[open]') && !!saved");
    const saved = await run('saved.models.at(-1)');
    assert.equal(saved.authentication.accountId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(saved.apiKey, ''); assert.equal(saved.baseUrl, 'https://api.openai.com/v1'); assert.equal(saved.apiProtocol, 'openai_responses');
    assert.equal(saved.maxCompletionTokens, undefined); assert.deepEqual(saved.defaultHeaders, {});
    assert.equal(await run('saved.models[0].hasApiKey'), true);
    await run(`delayA=true;document.querySelector('[aria-label="编辑 gpt-latest-a"]').click();void 0`);
    await until('typeof releaseA === "function"');
    await choose('ChatGPT 账号', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await until('catalogCalls.at(-1)===accountB'); await run('releaseA();void 0');
    await choose('账号可用模型', 'gpt-latest-b');
    assert.equal(await run("document.querySelector('.model-name-row input').value"), 'gpt-latest-b');
    await click('保存模型'); await until("!document.querySelector('dialog[open]')");
    assert.equal(await run('saved.models.at(-1).authentication.accountId'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await run('render("remote-agent");void 0'); await click('添加模型');
    await until("!!document.querySelector('dialog[open]')");
    assert.equal(await run("document.body.innerText.includes('Continue with ChatGPT')"), false);
    assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []);
    console.log('SIWC model UI: sign-in, catalog, save, account-switch races, welcome and remote boundary passed.');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
