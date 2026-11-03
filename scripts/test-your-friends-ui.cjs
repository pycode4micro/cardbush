// Real UI components in an isolated renderer. No model, account, microphone, or user profile access.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), electron = require('electron');
if (typeof electron === 'string') {
  fs.mkdirSync('tmp', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('tmp/your-friends-ui-'));
  buildFixture(directory).then(() => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], { env, windowsHide: true, stdio: 'inherit', timeout: 65000 });
    if (result.error) console.error(result.error); process.exitCode = result.status ?? 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else runFixture();

async function buildFixture(directory) {
  const { build } = await import('vite'), { default: react } = await import('@vitejs/plugin-react');
  const file = value => JSON.stringify(path.resolve(value).replaceAll('\\', '/'));
  const result = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react(), {
    name: 'friends-fixture', enforce: 'pre', resolveId(source, importer) {
      if (source.endsWith('__friends_fixture__.tsx')) return '\0friends-fixture.tsx';
      if (source === '../appCenter/AppCenter' && importer?.endsWith('ChatSidebar.tsx')) return '\0friends-dock.ts';
      if (source === '../automations/useAutomationUnreadCount') return '\0friends-unread.ts';
    }, load(id) {
      if (id === '\0friends-dock.ts') return 'export const AppCenterDock=()=>null;';
      if (id === '\0friends-unread.ts') return 'export const useAutomationUnreadCount=()=>0;';
      if (id !== '\0friends-fixture.tsx') return;
      return `import React,{useState,useRef,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';
        import {YourFriendsShell} from ${file('src/features/yourFriends/YourFriendsShell.tsx')};
        import {YourFriendsSettings} from ${file('src/features/yourFriends/YourFriendsSettings.tsx')};
        import {ChatSidebar} from ${file('src/features/sidebar/ChatSidebar.tsx')};
        import * as store from ${file('src/features/yourFriends/friendsStore.ts')};
        import {uiText} from ${file('src/i18n/index.ts')};import {UiLanguageProvider} from ${file('src/i18n/react.tsx')};
        import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};import ${file('src/styles/appearance.css')};
        window.fixture={store,t:uiText};const noop=()=>{};
        function Fixture(){const [open,setOpen]=useState(store.friendsStartupEnabled),[origin,setOrigin]=useState(),[language,setLanguage]=useState('zh'),[theme,setTheme]=useState('bright');const entry=useRef();
          useLayoutEffect(()=>{if(!open)entry.current?.focus();},[open]);
          fixture.language=setLanguage;fixture.theme=setTheme;
          const enter=()=>{entry.current=document.querySelector('[data-nav-section="your-friends"]');const r=entry.current.getBoundingClientRect();setOrigin({x:r.left+r.width/2,y:r.top+r.height/2});setOpen(true);};
          fixture.open=enter;
          return <UiLanguageProvider language={language}><div className={'app theme-'+theme}>
            <div className="window-frame"/><main className="desktop-shell" inert={open?true:undefined} aria-hidden={open}>
              <ChatSidebar language={language} section={open?'your-friends':'assistant'} activeConversationId="" projects={[]} conversations={[]} changeReportsByConversation={{}}
                onSectionChange={section=>{if(section==='your-friends')enter();}} onConversationChange={noop} onCreateConversation={noop} onAddProject={noop} onProjectAction={noop}
                onDeleteConversation={noop} onRenameConversation={async()=>true} onOpenConversationChanges={noop} onOpenSettings={noop} onOpenSearch={noop}/>
              <section className="fixture-settings"><YourFriendsSettings language={language}/><textarea aria-label="fixture draft" defaultValue="retained workspace draft"/></section>
            </main>{open&&<YourFriendsShell language={language} origin={origin} onClose={()=>setOpen(false)}/>}
          </div></UiLanguageProvider>;
        }createRoot(document.getElementById('root')).render(<Fixture/>);`;
    },
  }], build: { write: false, minify: false, lib: { entry: path.resolve('src/__friends_fixture__.tsx'), name: 'FriendsFixture', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0].output : result.output;
  fs.writeFileSync(path.join(directory, 'index.html'), `<html><meta charset="utf-8"><style>${output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n')} .fixture-settings{padding:32px;overflow:auto;flex:1}</style><div id="root"></div><script>${output.find(item => item.type === 'chunk').code.replaceAll('</script', '<\\/script')}</script></html>`);
}

function runFixture() {
  const { app, BrowserWindow } = electron, directory = process.argv[2];
  app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = setTimeout(() => app.exit(1), 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1120, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const read = code => win.webContents.executeJavaScript(code);
    const until = async code => { for (let i = 0; i < 120; i++) { if (await read(code)) return; await pause(25); } throw Error('Timed out: ' + code + '\n' + await read('document.body.innerText') + '\n' + errors.join('\n')); };
    const click = selector => read(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
    const fill = (selector, value) => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const textButton = (container, key) => read(`(()=>{const label=fixture.t(document.documentElement.lang||'zh')(${JSON.stringify(key)});const b=[...document.querySelectorAll(${JSON.stringify(container + ' button')})].find(b=>b.textContent.trim()===label);if(!b)throw Error(label);b.click();})()`);
    const capture = async name => { await pause(100); fs.writeFileSync(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    try {
      await win.loadFile(path.join(directory, 'index.html'));
      await until('document.querySelector("[data-nav-section=your-friends]")');
      assert.ok(await read('document.querySelector("[data-nav-section=your-friends]").previousElementSibling.textContent.trim()'));
      // Real entry and measured animation origin; the workspace is retained and inert.
      await click('[data-nav-section="your-friends"]');
      await until('document.querySelector(".your-friends[data-phase=opening]")');
      assert.ok(await read(`(()=>{const n=document.querySelector('.your-friends'),r=n.getBoundingClientRect(),b=document.querySelector('[data-nav-section=your-friends]').getBoundingClientRect(),s=getComputedStyle(n);return Math.abs(parseFloat(s.getPropertyValue('--friend-origin-x'))-(b.left+b.width/2-r.left))<1&&Math.abs(parseFloat(s.getPropertyValue('--friend-origin-y'))-(b.top+b.height/2-r.top))<1;})()`));
      assert.equal(await read('document.querySelector(".desktop-shell").inert'), true);
      await until('document.querySelector(".your-friends[data-phase=open]")');
      await capture('introduction-bright');
      await fill('.friends-input-surface textarea', '`关键词` 和 ``含 `反引号` 的词``');
      await until('document.querySelectorAll(".friends-input-surface .composer-code-mark").length===2');
      assert.equal(await read('document.querySelector(".friends-input-surface textarea").value'), '`关键词` 和 ``含 `反引号` 的词``');
      await win.setContentSize(1120, 720); await pause(100);
      assert.ok(await read(`(()=>{const input=document.querySelector('.friends-input-surface textarea'),a=input.getBoundingClientRect(),b=document.querySelector('.friends-input-surface .composer-code-highlights').getBoundingClientRect();return Math.abs(a.left+input.clientLeft-b.left)<1&&Math.abs(a.top+input.clientTop-b.top)<1;})()`), 'height-only resize keeps the independent input highlight aligned');
      await win.setContentSize(1120, 850);
      await fill('.friends-input-surface textarea', '叫我小林'); await click('.friends-send');
      await until('fixture.store.readFriendsState().introduction.step===1');
      await fill('.friends-input-surface textarea', '白天做产品，下班想看 NBA 和打台球。');
      await click('.friends-back'); await until('!document.querySelector(".your-friends")');
      await until('document.activeElement.dataset.navSection==="your-friends"');
      assert.equal(await read('document.querySelector(".fixture-settings textarea").value'), 'retained workspace draft');
      await click('[data-nav-section="your-friends"]'); await until('document.querySelector(".your-friends[data-phase=open]")');
      assert.equal(await read('document.querySelector(".friends-input-surface textarea").value'), '白天做产品，下班想看 NBA 和打台球。');
      // IME Enter must never record an event; the normal send shortcut records once.
      await read(`document.querySelector('.friends-input-surface textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true}));void 0`);
      assert.equal(await read('fixture.store.readFriendsState().events.length'), 1);
      await read(`document.querySelector('.friends-input-surface textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));void 0`);
      await until('fixture.store.readFriendsState().introduction.step===2');
      await fill('.friends-input-surface textarea', '这个问题我还想想');
      await textButton('.friends-step-actions', 'yourFriends.skip');
      await until('document.querySelector(".friends-input-surface textarea").value===""');
      await textButton('.friends-step-actions', 'yourFriends.previous');
      await until('document.querySelector(".friends-input-surface textarea").value==="这个问题我还想想"');
      await textButton('.friends-step-actions', 'yourFriends.skip');
      await fill('.friends-input-surface textarea', '只看官方赛程，晚上不要打扰我。'); await click('.friends-send');
      await until('fixture.store.readFriendsState().introduction.step===4');
      await textButton('.friends-step-actions', 'yourFriends.keepSelection');
      await click('.friends-tones [data-tone="sage"]');
      await textButton('.friends-step-actions', 'yourFriends.keepSelection');
      await until('document.querySelectorAll(".friends-confirm input").length===2');
      assert.equal(await read('document.querySelector(".friends-review .friends-primary").disabled'), true);
      await click('.friends-confirm:first-of-type input');
      assert.equal(await read('document.querySelector(".friends-review .friends-primary").disabled'), true, 'profile confirmation cannot grant boundaries');
      await click('.friends-confirm:last-of-type input'); await click('.friends-review .friends-primary');
      await until('fixture.store.readFriendsState().introduction.confirmedAt');
      // User events preserve exact text; the stage only shows the relevant acknowledgement.
      const utterance = '  明天有 NBA 比赛时告诉我。\n喜欢看精彩的比赛。  ';
      await fill('.friends-input-surface textarea', utterance); await click('.friends-send');
      await until('document.querySelector(".friends-receipt")');
      assert.equal(await read('fixture.store.readFriendsState().events.at(-1).text'), utterance);
      assert.equal(await read('document.querySelector(".friends-stage").textContent.includes("明天有 NBA")'), false);
      await click('.friends-header nav button:first-child'); await until('document.querySelector(".friends-dialog[open]")');
      assert.equal(await read('document.querySelector(".friends-event-list li:first-child p").textContent'), utterance);
      await textButton('.friends-event-list li:first-child', 'yourFriends.continue');
      await until('!document.querySelector(".friends-dialog")');
      await until('document.activeElement===document.querySelector(".friends-input-surface textarea")');
      await fill('.friends-input-surface textarea', '优先关注湖人。'); await click('.friends-send');
      assert.ok(await read('fixture.store.readFriendsState().events.at(-1).relatesTo===fixture.store.readFriendsState().events.at(-2).id'));
      await click('.friends-header nav button:first-child'); await textButton('.friends-event-list li:first-child', 'yourFriends.archive');
      assert.equal(await read('fixture.store.readFriendsState().events.at(-1).archived'), true);
      await click('.friends-dialog header button');
      // Quota failures must keep text, leave the event log untouched and recover on retry.
      const before = await read('fixture.store.readFriendsState().events.length');
      await read(`fixture.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('fixture quota','QuotaExceededError');};void 0`);
      await fill('.friends-input-surface textarea', '保存失败时保留我'); await click('.friends-send');
      assert.equal(await read('fixture.store.readFriendsState().events.length'), before);
      assert.equal(await read('document.querySelector(".friends-input-surface textarea").value'), '保存失败时保留我');
      assert.ok(await read('document.querySelector(".friends-input-dock [role=alert]")'));
      await read('Storage.prototype.setItem=fixture.originalSet;void 0'); await click('.friends-send');
      await until(`fixture.store.readFriendsState().events.length===${before + 1}`);
      // Progressive example has an explicit disclosure and never produces user events.
      await click('.friends-demo-invite'); await click('.friends-demo .friends-primary'); await click('.friends-demo .friends-primary');
      assert.equal(await read('document.querySelectorAll(".friends-artifact").length'), 1);
      assert.equal(await read('fixture.store.readFriendsState().events.length'), before + 1);
      assert.ok(await read('document.querySelector(".friends-demo").textContent.includes("不会读取或修改")'));
      await capture('event-bright');
      await read('fixture.theme("dark");void 0'); await capture('event-dark');
      assert.equal(await read('document.querySelector(".friends-input-dock").parentElement===document.querySelector(".friends-stage").parentElement'), true, 'input is outside the stage');
      // Settings update the real sidebar, persist startup preference and respect reduced motion.
      await click('.friends-header nav button:last-child');
      await fill('.friends-dialog .settings-field input', '团子');
      await textButton('.friends-dialog', 'yourFriends.saveName');
      await click('.friends-dialog .settings-switch input');
      assert.equal(await read('fixture.store.friendsStartupEnabled()'), true);
      assert.equal(await read('document.querySelector("[data-nav-section=your-friends]").textContent.trim()'), '团子');
      await click('.friends-dialog .settings-switch:last-of-type input');
      await click('.friends-dialog header button');
      assert.equal(await read('getComputedStyle(document.querySelector(".friend-avatar-body")).animationDuration'), '1e-05s');
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await until('document.querySelector(".friends-header nav button").getAttribute("aria-label")==="Events"');
      await read('fixture.store.updateFriendsState(s=>({...s,name:"A very long companion name that should fit a small window"}));void 0');
      await win.setContentSize(390, 740); await pause(120);
      assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'));
      assert.ok(await read(`(()=>{const r=document.querySelector('.friends-input-surface').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`));
      await capture('event-narrow-en');
      await read('fixture.store.updateFriendsState(s=>({...s,name:"团子"}));void 0');
      // Reload uses the saved default destination, profile, name and immutable event history.
      await win.reload(); await until('document.querySelector(".your-friends[data-phase=open]")');
      assert.equal(await read('document.querySelector(".friends-brand>span").textContent'), '团子');
      assert.equal(await read('fixture.store.readFriendsState().events.length'), before + 1);
      // Geometry covers every corner, including origins beyond the new viewport after resize.
      assert.ok(await read(`(()=>{const b={left:20,top:36,width:390,height:700};return [{x:1,y:1},{x:1200,y:900},{x:200,y:200}].every(o=>{const g=fixture.store.circleGeometry(b,o);return [[0,0],[390,0],[0,700],[390,700]].every(([x,y])=>Math.hypot(x-g.x,y-g.y)<=g.radius+.001);});})()`));
      // Corrupt saved state is never overwritten with a blank profile on the next edit.
      assert.ok(await read(`(()=>{const k=fixture.store.friendsStorageKey,raw=localStorage.getItem(k);localStorage.setItem(k,'{broken');let blocked=false;try{fixture.store.updateFriendsState(s=>({...s,name:'overwrite'}));}catch{blocked=true;}const retained=localStorage.getItem(k)==='{broken';localStorage.setItem(k,raw);fixture.store.updateFriendsState(s=>s);return blocked&&retained;})()`));
      assert.ok(await read(`(()=>{try{fixture.store.recordFriendEvent('orphan',undefined,'missing-event');return false;}catch{return true;}})()`));
      assert.deepEqual(errors, []);
      console.log('Your Friends UI passed: entry/return, resume, IME, independent confirmations, event provenance/relations, failed saves, demo, settings/startup, language, themes, narrow layout and motion. Screenshots: ' + directory);
    } finally { win.destroy(); clearTimeout(deadline); }
    app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
