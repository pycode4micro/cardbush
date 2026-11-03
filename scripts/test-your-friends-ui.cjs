// Real UI components in an isolated renderer. No model, account, microphone, or user profile access.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), electron = require('electron');
const timeout = process.env.CARDBUSH_FRIENDS_FLOW_CAPTURE === '1' ? 90000 : 60000;
if (typeof electron === 'string') {
  fs.mkdirSync('tmp', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('tmp/your-friends-ui-'));
  buildFixture(directory).then(() => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], { env, windowsHide: true, stdio: 'inherit', timeout: timeout + 5000 });
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
        import {generateFriendAppearance} from ${file('src/features/yourFriends/generateFriendAppearance.ts')};
        import {validFriendSvg} from ${file('src/features/yourFriends/friendDesign.ts')};
        import {uiText} from ${file('src/i18n/index.ts')};import {UiLanguageProvider} from ${file('src/i18n/react.tsx')};
        import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};import ${file('src/styles/appearance.css')};
        window.fixture={store,t:uiText,validFriendSvg,requests:[],hold:false,fail:false};const noop=()=>{};
        fixture.design={name:'夜航',description:'认知资料中的安静陪伴与运动兴趣，作为设计参考。',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><path fill="#9ab5d0" d="M48 80Q40 32 80 62Q120 40 160 62Q200 32 192 80L184 166Q120 216 56 166Z"/><ellipse fill="#fff3da" cx="120" cy="130" rx="52" ry="46"/><circle fill="#344157" cx="99" cy="118" r="5"/><circle fill="#344157" cx="141" cy="118" r="5"/><path fill="#d5a77d" d="M112 132L128 132L120 143Z"/></svg>'};
        fixture.generate=(input,signal)=>generateFriendAppearance(input,async()=>({sessionId:'model-settings-owner',model:'configured-test-model',userInput:'',projectDir:'must-not-inherit',teamInstructions:'must-not-inherit'}),signal,{
          createConversation:async options=>{fixture.created=options;return {id:options.sessionId};},
          streamChat:async request=>{fixture.requests.push(request);if(fixture.hold)await new Promise(resolve=>{fixture.release=resolve;});
            if(request.signal.aborted)return;
            if(fixture.fail){request.onDone({status:'failed'});return;}
            request.onFinalAssistantText(JSON.stringify(fixture.design),{});request.onDone({status:'completed'});}
        });
        function Fixture(){const [open,setOpen]=useState(store.friendsStartupEnabled),[origin,setOrigin]=useState(),[language,setLanguage]=useState('zh'),[theme,setTheme]=useState('bright');const entry=useRef();
          useLayoutEffect(()=>{if(!open)(entry.current??document.querySelector('[data-nav-section="your-friends"]'))?.focus();},[open]);
          fixture.language=setLanguage;fixture.theme=setTheme;
          const enter=()=>{entry.current=document.querySelector('[data-nav-section="your-friends"]');const r=entry.current.getBoundingClientRect();setOrigin({x:r.left+r.width/2,y:r.top+r.height/2});setOpen(true);};
          fixture.open=enter;
          return <UiLanguageProvider language={language}><div className={'app theme-'+theme}>
            <div className="window-frame"/><main className="desktop-shell" inert={open?true:undefined} aria-hidden={open}>
              <ChatSidebar language={language} section={open?'your-friends':'assistant'} activeConversationId="" projects={[]} conversations={[]} changeReportsByConversation={{}}
                onSectionChange={section=>{if(section==='your-friends')enter();}} onConversationChange={noop} onCreateConversation={noop} onAddProject={noop} onProjectAction={noop}
                onDeleteConversation={noop} onRenameConversation={async()=>true} onOpenConversationChanges={noop} onOpenSettings={noop} onOpenSearch={noop}/>
              <section className="fixture-settings"><YourFriendsSettings language={language}/><textarea aria-label="fixture draft" defaultValue="retained workspace draft"/></section>
            </main>{open&&<YourFriendsShell language={language} origin={origin} generateAppearance={fixture.generate} onClose={()=>setOpen(false)}/>}
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
  const deadline = setTimeout(() => app.exit(1), timeout);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1120, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const read = code => win.webContents.executeJavaScript(code);
    const until = async code => { for (let i = 0; i < 120; i++) { if (await read(code)) return; await pause(25); } throw Error('Timed out: ' + code + '\n' + await read('document.body.innerText') + '\n' + errors.join('\n')); };
    const settle = () => until('!document.querySelector(".friends-onboarding-scene:not([data-phase=idle])")');
    const click = async selector => { await settle(); await read(`document.querySelector(${JSON.stringify(selector)}).click();void 0`); await settle(); };
    const fill = async (selector, value) => { await settle(); return read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`); };
    const textButton = async (container, key) => { await settle(); await read(`(()=>{const label=fixture.t(document.documentElement.lang||'zh')(${JSON.stringify(key)});const b=[...document.querySelectorAll(${JSON.stringify(container + ' button')})].find(b=>b.textContent.trim()===label);if(!b)throw Error(label);b.click();})()`); await settle(); };
    const capture = async name => { await pause(100); fs.writeFileSync(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const fitsViewport = async (scope, label) => {
      await settle();
      await pause(100);
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const failures = await read(`(()=>{const root=document.querySelector(${JSON.stringify(scope)}), failures=[];
        const containers=['.friends-stage','.friends-story','.friends-onboarding','.friends-onboarding-scene','.friends-onboarding-question','.friends-review','.friends-appearance-editor','.friends-design-workspace','.friends-design-step','.friends-generated-preview','.friends-design-controls','.friends-dialog-body','.friends-text-viewport'];
        for(const node of [root,...root.querySelectorAll(containers.join(','))]){
          if(node.scrollHeight>node.clientHeight+2||node.scrollWidth>node.clientWidth+2)failures.push(node.className+': overflow '+node.scrollHeight+'/'+node.clientHeight+' '+node.scrollWidth+'/'+node.clientWidth);
        }
        for(const node of root.querySelectorAll('button,input,select,textarea,h1,.friends-lead,.friends-page-text')){
          if(!node.getClientRects().length||getComputedStyle(node).visibility==='hidden')continue;
          const r=node.getBoundingClientRect();
          if(r.top<0||r.left<0||r.right>innerWidth+1||r.bottom>innerHeight+1)failures.push(node.className+': outside viewport');
        }
        const artwork=root.querySelector('.friends-generated-preview .friend-avatar');if(artwork?.getClientRects().length){const r=artwork.getBoundingClientRect(),canvas=artwork.parentElement.getBoundingClientRect();if(r.height<24||r.width<24||r.bottom>canvas.bottom+1||r.top<canvas.top-1)failures.push('artwork is clipped or too small: '+r.height);}
        for(const tile of root.querySelectorAll('.friends-characters .friend-avatar')){const r=tile.getBoundingClientRect();if(r.height<24||r.width<24)failures.push('preset artwork must remain visible');}
        return failures;})()`);
      if(failures.length) await capture('layout-failure');
      assert.deepEqual(failures, [], label);
    };
    const fitsMinimumWindow = async (scope, label) => {
      await win.setContentSize(480, 480);
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await fitsViewport(scope, label + ' at the app minimum window size');
      await read('fixture.language("zh");document.documentElement.lang="zh";void 0');
      await fitsViewport(scope, label + ' in Chinese at minimum size');
      await win.setContentSize(1120, 850);
    };
    try {
      await win.loadFile(path.join(directory, 'index.html'));
      await until('document.querySelector("[data-nav-section=your-friends]")');
      assert.ok(await read('document.querySelector("[data-nav-section=your-friends]").previousElementSibling.textContent.trim()'));
      // Real entry and measured animation origin; the workspace is retained and inert.
      await click('[data-nav-section="your-friends"]');
      await until('document.querySelector(".your-friends[data-phase=opening]")');
      assert.equal(await read('!!document.querySelector(".friends-transition")'), true, 'entry uses temporary geometry');
      assert.equal(await read('document.querySelector(".friends-stage").inert'), true, 'controls are inactive while the entrance is concealed');
      assert.ok(await read(`(()=>{const n=document.querySelector('.your-friends'),b=document.querySelector('[data-nav-section=your-friends]').getBoundingClientRect(),s=getComputedStyle(n);return Math.abs(parseFloat(s.getPropertyValue('--friend-origin-x'))-(b.left+b.width/2-n.offsetLeft))<1&&Math.abs(parseFloat(s.getPropertyValue('--friend-origin-y'))-(b.top+b.height/2-n.offsetTop))<1;})()`));
      assert.equal(await read('document.querySelector(".desktop-shell").inert'), true);
      await until('document.querySelector(".your-friends[data-phase=open]")');
      assert.equal(await read('!!document.querySelector(".friends-transition,.friend-avatar")'), false, 'no geometric avatar or placeholder remains after entry');
      assert.equal(await read('document.querySelector(".friends-stage").inert'), false);
      assert.ok(await read(`(()=>{const app=document.querySelector('.app'),root=document.querySelector('.your-friends'),before=app.getAttribute('style');try{app.style.setProperty('--bg','#213247');app.style.setProperty('--text','#f2e4d7');app.style.setProperty('--accent','#c98742');const a=getComputedStyle(app),r=getComputedStyle(root);return a.backgroundColor===r.backgroundColor&&a.color===r.color&&a.getPropertyValue('--accent').trim()===r.getPropertyValue('--friend-tint').trim();}finally{if(before===null)app.removeAttribute('style');else app.setAttribute('style',before);}})()`), 'custom theme colours flow into Friends without a separate palette');
      await capture('introduction-bright');
      assert.equal(await read('!!document.querySelector(".friends-header nav")'), false, 'setup does not compete with events, settings or appearance navigation');
      assert.equal(await read('document.querySelectorAll(".friends-onboarding .friends-primary").length'), 1, 'one primary action per question');
      assert.ok(await read(`(()=>{const input=document.querySelector('.friends-input-surface').getBoundingClientRect(),heading=document.querySelector('.friends-onboarding-heading').getBoundingClientRect();return input.top-heading.bottom<80;})()`), 'answer stays next to its question instead of in the bottom chat dock');
      await fitsMinimumWindow('.your-friends', 'recognition');
      await fitsViewport('.your-friends', 'recognition has no scrolling surfaces');
      await win.setContentSize(390, 640); await fitsViewport('.your-friends', 'narrow recognition fits');
      await capture('introduction-narrow'); await win.setContentSize(1120, 850);
      assert.equal(await read('fixture.store.introductionSteps[fixture.store.readFriendsState().introduction.step]'), 'address');
      assert.equal(await read('fixture.store.readFriendsState().appearance'), undefined, 'a preset is never selected by default');
      assert.equal(await read('fixture.requests.length'), 0, 'recognition precedes generation');
      await fill('.friends-input-surface textarea', '`关键词` 和 ``含 `反引号` 的词``');
      await until('document.querySelectorAll(".friends-input-surface .composer-code-mark").length===2');
      assert.equal(await read('document.querySelector(".friends-input-surface textarea").value'), '`关键词` 和 ``含 `反引号` 的词``');
      await win.setContentSize(1120, 720); await pause(100);
      assert.ok(await read(`(()=>{const input=document.querySelector('.friends-input-surface textarea'),a=input.getBoundingClientRect(),b=document.querySelector('.friends-input-surface .composer-code-highlights').getBoundingClientRect();return Math.abs(a.left+input.clientLeft-b.left)<1&&Math.abs(a.top+input.clientTop-b.top)<1;})()`), 'height-only resize keeps the independent input highlight aligned');
      await win.setContentSize(1120, 850);
      await fill('.friends-input-surface textarea', '叫我小林');
      await read(`document.querySelector('.friends-send').click();document.querySelector('.friends-send').click();void 0`);
      await until('document.querySelector(".friends-onboarding-scene[data-phase=leaving]")');
      await until('fixture.store.readFriendsState().introduction.step===1');
      await settle();
      assert.equal(await read('fixture.store.readFriendsState().events.length'), 1, 'repeated clicks during the transition only record once');
      assert.equal(await read('document.activeElement.id'), 'friends-step-title', 'the new question receives focus after becoming interactive');
      await fill('.friends-input-surface textarea', '白天做产品，下班想看 NBA 和打台球。');
      await click('.friends-back');
      await until('document.querySelector(".your-friends[data-phase=closing] .friends-transition")');
      await until('!document.querySelector(".your-friends")');
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
      await fitsMinimumWindow('.your-friends', 'boundaries');
      await win.setContentSize(390, 640); await fitsViewport('.your-friends', 'boundary controls fit without scrolling');
      await win.setContentSize(1120, 850);
      await click('.friends-boundary-continue');
      assert.equal(await read('document.querySelector(".friends-boundary-flow").dataset.part'), 'report');
      await fitsMinimumWindow('.your-friends', 'report preference');
      await click('.friends-add-boundary-note');
      await fill('.friends-input-surface textarea', '涉及购买时先问我。');
      await fitsMinimumWindow('.your-friends', 'optional boundary note');
      await textButton('.friends-step-actions', 'yourFriends.previous');
      assert.equal(await read('document.querySelector(".friends-boundary-flow").dataset.part'), 'report');
      await click('.friends-add-boundary-note');
      assert.equal(await read('document.querySelector(".friends-input-surface textarea").value'), '涉及购买时先问我。');
      await click('.friends-boundary-continue');
      assert.equal(await read('fixture.store.readFriendsState().introduction.answers.boundaries'), '涉及购买时先问我。');
      await until('document.querySelector(".friends-generate")');
      assert.equal(await read('!!document.querySelector(".friends-generated-preview,.friend-avatar")'), false, 'before generation there is no placeholder artwork or empty portrait card');
      assert.equal(await read('document.querySelector(".friends-appearance-editor").dataset.mode'), 'generate', 'presets remain a secondary option');
      assert.equal(await read('!!document.querySelector(".friends-builtin-options")'), false, 'preset controls do not stack below generation');
      assert.equal(await read('!!document.querySelector(".friends-input-surface")'), false);
      await capture('appearance-before-generation');
      await fitsMinimumWindow('.your-friends', 'appearance generation');
      await fitsViewport('.your-friends', 'design fits in one viewport');
      await win.setContentSize(390, 640); await fitsViewport('.your-friends', 'narrow design fits in one viewport');
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await fitsViewport('.your-friends', 'English design fits in a short narrow window');
      await capture('design-narrow-en');
      await read('fixture.language("zh");document.documentElement.lang="zh";void 0');
      await win.setContentSize(1120, 850);
      // The production adapter receives recognition data and uses the configured model, not a canned selector.
      await click('.friends-generate');
      await until('document.querySelector(".friends-apply-design")');
      assert.equal(await read('fixture.store.readFriendsState().appearance'), undefined, 'a generated preview is not applied without choosing it');
      assert.ok(await read(`(()=>{const r=fixture.requests.at(-1);return r.model==='configured-test-model'&&r.allowedTools.length===0&&r.allowedSkills.length===0&&!r.teamModeEnabled&&!r.projectDir&&!r.teamInstructions&&r.userInput.includes('白天做产品，下班想看 NBA 和打台球。')&&r.userInput.includes('只看官方赛程，晚上不要打扰我。')&&fixture.created.metadata.hidden===true;})()`));
      assert.ok(await read('document.querySelector(".friends-design-explanation").textContent.includes("夜航")'));
      assert.equal(await read('!!document.querySelector(".friends-design-feedback textarea")'), false, 'the first preview focuses on adopting or refining, without an always-open form');
      await read('fixture.design.name="夜航与安静的自然轮廓".repeat(6);fixture.design.description="根据你的日常和交流偏好，采用克制的线条、自然配色和清晰轮廓。".repeat(18);void 0');
      await click('.friends-refine-design');
      await fill('.friends-design-feedback textarea', '更像猫一些，保留安静的表情');
      await click('.friends-generate'); await until('document.querySelector(".friends-apply-design")');
      assert.ok(await read('fixture.requests.at(-1).userInput.includes("更像猫一些")&&fixture.requests.at(-1).userInput.includes("previousDesign")'));
      await click('.friends-explanation-toggle');
      await win.setContentSize(390, 640);
      await fitsViewport('.your-friends', 'long design notes paginate within the preview');
      await until('document.querySelector(".friends-generated-preview .friends-page-navigation").dataset.multiple==="true"');
      const readPages = selector => read(`(async()=>{let result='';const root=document.querySelector(${JSON.stringify(selector)});for(let i=0;i<1000;i++){result+=root.querySelector('.friends-page-text').textContent;const next=root.querySelector('.friends-page-navigation button:last-child');if(next.disabled)return result;next.click();await new Promise(requestAnimationFrame);}throw Error('pagination did not end');})()`);
      assert.equal(await readPages('.friends-generated-preview'), await read('fixture.design.name+"\\n\\n"+fixture.design.description'), 'the full name and every design note character remain accessible');
      await capture('design-notes-narrow');
      await win.setContentSize(1120, 850); await click('.friends-explanation-toggle');
      // Cancellation and failures keep the preview and cannot silently apply a preset or a late result.
      await click('.friends-refine-design');
      await read('fixture.hold=true;void 0'); await click('.friends-generate');
      await until('document.querySelector(".friends-generation-cancel")');
      await click('.friends-generation-cancel'); await read('fixture.release();fixture.hold=false;void 0');
      assert.equal(await read('fixture.requests.at(-1).signal.aborted'), true);
      await read('fixture.fail=true;void 0'); await click('.friends-generate');
      await until('document.querySelector(".friends-appearance-editor [role=alert]")');
      await fitsMinimumWindow('.your-friends', 'generation error');
      await win.setContentSize(390, 640); await fitsViewport('.your-friends', 'generation failure keeps actions visible');
      await win.setContentSize(1120, 850);
      assert.equal(await read('fixture.store.readFriendsState().appearance'), undefined);
      await read('fixture.fail=false;void 0');
      await click('.friends-refine-cancel');
      await click('.friends-apply-design');
      await until('document.querySelectorAll(".friends-confirm input").length===2');
      assert.equal(await read('fixture.store.readFriendsState().appearance.type'), 'generated');
      assert.equal(await read('fixture.store.readFriendsState().appearance.design.svg'), await read('fixture.design.svg'));
      await fitsViewport('.your-friends', 'review fits without a stacked answer list');
      await fitsMinimumWindow('.your-friends', 'review');
      await click('.friends-review-return');
      const reviewSection = async key => {
        const target = await read(`fixture.store.introductionSteps.indexOf(${JSON.stringify(key)})`);
        for (let count = 0; count < 6; count++) {
          const current = await read('fixture.store.introductionSteps.indexOf(document.querySelector(".friends-review-reader").dataset.section)');
          if (current === target) return;
          await click(current < target ? '.friends-review-section-next' : '.friends-review-section-previous');
        }
        throw Error('Unable to navigate profile section: ' + key);
      };
      await read('fixture.savedContext=fixture.store.readFriendsState().introduction.answers.context;fixture.longContext="我希望留出时间运动、阅读和思考。👨‍👩‍👧‍👦\\n".repeat(80);fixture.store.updateFriendsState(s=>({...s,introduction:{...s.introduction,answers:{...s.introduction.answers,context:fixture.longContext}}}));void 0');
      await reviewSection('context');
      await win.setContentSize(390, 640);
      await until('document.querySelector(".friends-review .friends-page-navigation").dataset.multiple==="true"');
      await fitsViewport('.your-friends', 'long recognition text fits review without scrollbars');
      assert.equal(await readPages('.friends-review'), await read('fixture.longContext'), 'review preserves every character, newline and emoji');
      await capture('review-narrow');
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await fitsViewport('.your-friends', 'English review fits in a short narrow window');
      await read('fixture.language("zh");document.documentElement.lang="zh";fixture.store.updateFriendsState(s=>({...s,introduction:{...s.introduction,answers:{...s.introduction.answers,context:fixture.savedContext}}}));void 0');
      await win.setContentSize(1120, 850);
      // Reviewing the appearance returns to the same confirmation step.
      await reviewSection('appearance');
      await click('.friends-review-edit');
      await until('document.querySelector(".friends-apply-design")');
      await click('.friends-apply-design');
      await until('document.querySelectorAll(".friends-confirm input").length===2');
      await fitsMinimumWindow('.your-friends', 'final confirmation');
      await win.setContentSize(390, 640); await fitsViewport('.your-friends', 'final confirmation fits without scrolling');
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await fitsViewport('.your-friends', 'English confirmation fits without scrolling');
      await read('fixture.language("zh");document.documentElement.lang="zh";void 0');
      await win.setContentSize(1120, 850);
      assert.equal(await read('document.querySelector(".friends-review .friends-primary").disabled'), true);
      await click('.friends-confirm:first-of-type input');
      assert.equal(await read('document.querySelector(".friends-review .friends-primary").disabled'), true, 'profile confirmation cannot grant boundaries');
      await click('.friends-confirm:last-of-type input'); await click('.friends-review .friends-primary');
      await until('fixture.store.readFriendsState().introduction.confirmedAt');
      assert.equal(await read('!!document.querySelector(".friends-stage .friend-avatar")'), false, 'the home view does not display a character, including a generated one');
      // User events preserve exact text; the stage only shows the relevant acknowledgement.
      const utterance = '  明天有 NBA 比赛时告诉我。\n喜欢看精彩的比赛。  ';
      await fill('.friends-input-surface textarea', utterance); await click('.friends-send');
      await until('document.querySelector(".friends-receipt")');
      assert.equal(await read('fixture.store.readFriendsState().events.at(-1).text'), utterance);
      assert.equal(await read('document.querySelector(".friends-stage").textContent.includes("明天有 NBA")'), false);
      await click('.friends-header [data-panel="events"]'); await until('document.querySelector(".friends-dialog[open]")');
      assert.equal(await read('document.querySelector(".friends-event-list li:first-child p").textContent'), utterance);
      await textButton('.friends-event-list li:first-child', 'yourFriends.continue');
      await until('!document.querySelector(".friends-dialog")');
      await until('document.activeElement===document.querySelector(".friends-input-surface textarea")');
      await fill('.friends-input-surface textarea', '优先关注湖人。'); await click('.friends-send');
      assert.ok(await read('fixture.store.readFriendsState().events.at(-1).relatesTo===fixture.store.readFriendsState().events.at(-2).id'));
      await click('.friends-header [data-panel="events"]'); await textButton('.friends-event-list li:first-child', 'yourFriends.archive');
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
      const confirmed = await read('fixture.store.readFriendsState().introduction.confirmedAt');
      await click('.friends-header [data-panel="appearance"]');
      await click('.friends-design-method[data-mode="builtin"]');
      assert.equal(await read('document.querySelectorAll(".friends-characters button").length'), 3, 'keep all three fallback characters, including Cat');
      await click('.friends-characters [data-character="cat"]');
      await click('.friends-tones [data-tone="sage"]');
      await until('document.querySelector(".your-friends").dataset.tone==="sage"');
      assert.ok(await read(`(()=>{const s=getComputedStyle(document.querySelector('.friends-appearance-editor .friend-avatar'));return s.getPropertyValue('--friend-tint').trim()===s.getPropertyValue('--friend-sage').trim();})()`));
      assert.ok(await read(`(()=>{const s=getComputedStyle(document.querySelector('.your-friends')),app=getComputedStyle(document.querySelector('.app'));return s.backgroundColor===app.backgroundColor&&s.color===app.color&&s.getPropertyValue('--friend-tint').trim()===app.getPropertyValue('--accent').trim();})()`), 'a preset palette never recolours the main theme');
      await capture('appearance-fallback-cat');
      await fitsMinimumWindow('.friends-dialog', 'preset selection');
      await fitsViewport('.friends-dialog', 'appearance dialog has no nested scrolling');
      await capture('appearance-builtin-options');
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await until('document.querySelector(".friends-characters [data-character=cat]").textContent.includes("Cat")');
      await win.setContentSize(390, 740); await pause(120);
      await fitsViewport('.friends-dialog', 'all three presets fit the narrow dialog');
      assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'));
      assert.ok(await read(`(()=>{const r=document.querySelector('.friends-characters').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`));
      await capture('appearance-narrow-en');
      await read('fixture.language("zh");document.documentElement.lang="zh";void 0');
      await win.setContentSize(1120, 850);
      await click('.friends-apply-design');
      assert.equal(await read('fixture.store.readFriendsState().introduction.confirmedAt'), confirmed);
      assert.equal(await read('fixture.store.readFriendsState().events.length'), before + 1);
      assert.equal(await read('fixture.store.readFriendsState().appearance.character'), 'cat');
      assert.equal(await read('!!document.querySelector(".friends-stage .friend-avatar")'), false, 'even selected presets only appear inside the designer');
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
      await click('.friends-header [data-panel="appearance"]');
      assert.equal(await read('getComputedStyle(document.querySelector(".friend-avatar-body")).animationDuration'), '1e-05s');
      await click('.friends-dialog header button');
      await read('fixture.language("en");document.documentElement.lang="en";void 0');
      await until('document.querySelector(".friends-header [data-panel=events]").getAttribute("aria-label")==="Events"');
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
      assert.equal(await read('fixture.store.readFriendsState().appearance.character'), 'cat');
      // Model output is an inert, bounded SVG image; reject executable or remote content.
      assert.ok(await read(`(()=>{const check=fixture.validFriendSvg,wrap=s=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">'+s+'</svg>';return check(fixture.design.svg)&&[
        '<script>alert(1)</script>', '<image href="https://example.com/a.png"/>', '<path d="M1 1L2 2" onload="alert(1)"/>',
        '<foreignObject/>', '<path d="M1 1L2 2" fill="url(https://example.com)"/>', '<path style="fill:red" d="M1 1L2 2"/>',
        '<path d="M1 1L2 2" fill="url(#missing)"/>'
      ].every(s=>!check(wrap(s)))&&!check(fixture.design.svg.repeat(200));})()`));
      assert.ok(await read(`(()=>{const s=fixture.store,k=s.friendsStorageKey,raw=localStorage.getItem(k),base=s.readFriendsState();try{
        for(const step of [0,1,2,3,4,5,6]){const legacy={...base,version:1,introduction:{...base.introduction,step}};delete legacy.appearance;
          localStorage.setItem(k,JSON.stringify(legacy));const next=s.readFriendsState();
          if(next.version!==2||next.introduction.step!==step||next.appearance!==undefined||next.name!==base.name||JSON.stringify(next.events)!==JSON.stringify(base.events)||JSON.stringify(next.introduction.answers)!==JSON.stringify(base.introduction.answers)||next.introduction.confirmedAt!==base.introduction.confirmedAt||JSON.parse(localStorage.getItem(k)).version!==1)return false;
        }return true;
      }finally{localStorage.setItem(k,raw);s.updateFriendsState(v=>v);}})()`));
      // Geometry covers every corner, including origins beyond the new viewport after resize.
      assert.ok(await read(`(()=>{const b={left:20,top:36,width:390,height:700};return [{x:1,y:1},{x:1200,y:900},{x:200,y:200}].every(o=>{const g=fixture.store.circleGeometry(b,o);return [[0,0],[390,0],[0,700],[390,700]].every(([x,y])=>Math.hypot(x-g.x,y-g.y)<=g.radius+.001);});})()`));
      // Corrupt saved state is never overwritten with a blank profile on the next edit.
      assert.ok(await read(`(()=>{const k=fixture.store.friendsStorageKey,raw=localStorage.getItem(k);localStorage.setItem(k,'{broken');let blocked=false;try{fixture.store.updateFriendsState(s=>({...s,name:'overwrite'}));}catch{blocked=true;}const retained=localStorage.getItem(k)==='{broken';localStorage.setItem(k,raw);fixture.store.updateFriendsState(s=>s);return blocked&&retained;})()`));
      assert.ok(await read(`(()=>{try{fixture.store.recordFriendEvent('orphan',undefined,'missing-event');return false;}catch{return true;}})()`));
      // Startup, interrupted entry and global motion preferences must all finish and restore focus.
      await read('fixture.store.updateFriendsState(s=>({...s,motion:true}));void 0');
      await win.reload(); await until('document.querySelector(".your-friends[data-phase=opening]")');
      assert.ok(await read(`(()=>{const n=document.querySelector('.your-friends'),s=getComputedStyle(n);return Math.abs(parseFloat(s.getPropertyValue('--friend-aperture-x'))-n.clientWidth/2)<1;})()`), 'startup without a sidebar origin opens from the centre');
      await read(`document.querySelector('.your-friends').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
      await until('!document.querySelector(".your-friends")');
      await until('document.activeElement.dataset.navSection==="your-friends"');
      await read('document.documentElement.dataset.reduceMotion="true";fixture.open();void 0');
      await until('document.querySelector(".your-friends[data-phase=open]")');
      assert.equal(await read('!!document.querySelector(".friends-transition")'), false);
      await click('.friends-back'); await until('!document.querySelector(".your-friends")');
      await read('delete document.documentElement.dataset.reduceMotion;void 0');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await read('fixture.open();void 0'); await until('document.querySelector(".your-friends[data-phase=open]")');
      assert.equal(await read('!!document.querySelector(".friends-transition")'), false);
      await click('.friends-back'); await until('!document.querySelector(".your-friends")');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach();
      await read('fixture.store.updateFriendsState(s=>({...s,motion:false,appearance:undefined,introduction:{...s.introduction,step:5,confirmedAt:undefined}}));fixture.open();void 0');
      await until('document.querySelector(".your-friends[data-phase=open]")');
      await click('.friends-design-method[data-mode="builtin"]');
      await fitsMinimumWindow('.your-friends', 'unselected onboarding presets');
      await click('.friends-characters [data-character="cat"]');
      await fitsMinimumWindow('.your-friends', 'onboarding preset preview');
      await click('.friends-back'); await until('!document.querySelector(".your-friends")');
      if (process.env.CARDBUSH_FRIENDS_FLOW_CAPTURE === '1') {
        // The real internal flow at its normal timing; only the model transport is a fixture.
        await read('fixture.language("zh");document.documentElement.lang="zh";fixture.theme("bright");fixture.store.updateFriendsState(s=>({...s,name:"",motion:true,appearance:undefined,introduction:{step:0,answers:{}}}));for(const step of fixture.store.introductionSteps)fixture.store.saveFriendsDraft(null,step);fixture.design.name="夜航";fixture.design.description="根据安静的交流偏好，使用自然配色和简洁轮廓。";fixture.hold=false;fixture.fail=false;void 0');
        await win.setContentSize(1120, 760); await click('[data-nav-section="your-friends"]');
        await until('document.querySelector(".your-friends[data-phase=open]")');
        const framesDirectory = path.join(directory, 'internal-flow'); fs.mkdirSync(framesDirectory);
        const frames = [];
        const record = async (duration, action = async () => {}) => {
          const start = Date.now();
          await Promise.all([action(), (async () => {
            while (Date.now() - start < duration) {
              const time = Date.now(), file = String(frames.length).padStart(4, '0') + '.png';
              fs.writeFileSync(path.join(framesDirectory, file), (await win.webContents.capturePage()).toPNG());
              frames.push({ file, time }); await pause(30);
            }
          })()]);
        };
        await record(700);
        for (const answer of ['小林', '白天做产品，晚上喜欢运动和读书。', '清晰、有依据，也为生活留一些余地。', '简短直接，重要的事及时告诉我。']) {
          await record(700, () => fill('.friends-input-surface textarea', answer));
          await record(850, () => click('.friends-onboarding-next'));
        }
        await capture('flow-boundary');
        await record(950, () => click('.friends-boundary-continue'));
        await record(950, () => click('.friends-boundary-continue'));
        await capture('flow-appearance-prepare');
        await read('fixture.hold=true;void 0');
        await record(1100, () => click('.friends-generate'));
        await record(1400, async () => { await read('fixture.release();fixture.hold=false;void 0'); await until('document.querySelector(".friends-apply-design")'); });
        await capture('flow-appearance-preview');
        await record(1000, () => click('.friends-refine-design'));
        await record(800, () => fill('.friends-design-feedback textarea', '轮廓更简洁一些，保留安静的感觉。'));
        await record(1100, () => click('.friends-refine-cancel'));
        await record(1200, () => click('.friends-apply-design'));
        await capture('flow-confirmation');
        fs.writeFileSync(path.join(framesDirectory, 'frames.json'), JSON.stringify(frames));
        await read('fixture.theme("dark");void 0'); await capture('flow-confirmation-dark');
        await click('.friends-back'); await until('!document.querySelector(".your-friends")');
      }
      if (process.env.CARDBUSH_FRIENDS_MOTION_CAPTURE === '1') {
        // Record the real renderer at its actual timings, without mocking or slowing the animation.
        await read('fixture.store.updateFriendsState(s=>({...s,name:"",motion:true,appearance:undefined,introduction:{step:0,answers:{}}}));void 0');
        await win.setContentSize(1120, 760);
        for (const theme of ['bright', 'dark']) {
          await read(`fixture.theme(${JSON.stringify(theme)});void 0`); await pause(80);
          const framesDirectory = path.join(directory, 'motion-' + theme); fs.mkdirSync(framesDirectory);
          const frames = [];
          const frame = async () => { const time = Date.now(), file = String(frames.length).padStart(4, '0') + '.png'; fs.writeFileSync(path.join(framesDirectory, file), (await win.webContents.capturePage()).toPNG()); frames.push({ file, time }); };
          await frame(); await click('[data-nav-section="your-friends"]');
          const entered = Date.now();
          while (Date.now() - entered < 1500) { await frame(); await pause(30); }
          await capture('geometry-' + theme);
          await click('.friends-back'); const leaving = Date.now();
          while (Date.now() - leaving < 800) { await frame(); await pause(30); }
          await until('!document.querySelector(".your-friends")'); await frame();
          fs.writeFileSync(path.join(framesDirectory, 'frames.json'), JSON.stringify(frames));
        }
      }
      assert.deepEqual(errors, []);
      console.log('Your Friends UI passed: focused sequential onboarding, transition focus and repeated-click guard, boundary notes, recognition before generation, progressive preview/apply/redesign, cancellation/failure, optional presets, no placeholder or home avatar, theme inheritance, startup/interruption/reduced motion, inert SVG validation, v1 migration, IME, confirmations, failed saves, language and single-viewport layouts. Screenshots: ' + directory);
    } finally { win.destroy(); clearTimeout(deadline); }
    app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
