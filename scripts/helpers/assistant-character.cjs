const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
module.exports = async ({read,until,fill,click,pause,win,directory}) => {
    const characters = '.sidebar-footer .assistant-character, .assistant-view .topbar .assistant-character';
    const assertAnimatedCharacters = async state => {
      await until(`Array.from(document.querySelectorAll('${characters}')).length===2 && Array.from(document.querySelectorAll('${characters}')).every(n=>n.matches('.assistant-sprite[data-state=${state}]')&&n.querySelector('img')?.naturalWidth>0)`);
      assert.equal(await read(`Array.from(document.querySelectorAll('${characters} img')).some(n=>n.src===fixture.legacyAvatar)`), false, 'saved static images never replace the skin');
    };
    await read('document.documentElement.dataset.motionPreference="off";fixture.busy=false;delete fixture.activity;void 0');
    await assertAnimatedCharacters('idle');
    assert.equal(await read('localStorage.cardbush_personal_assistant_avatar_v1===fixture.legacyAvatar'), true, 'exercise an existing, valid saved avatar from first mount');
    const openSettings = async () => { await click('.profile-trigger'); await click('[data-profile-action=assistant]'); }, dialog = '.assistant-settings-dialog';
    const bounds = await read('document.querySelector(".composer-surface").getBoundingClientRect().toJSON()');
    await openSettings(); await until('document.querySelector(".assistant-settings-dialog:modal")');
    assert.equal(await read('document.querySelectorAll(".assistant-settings-dialog input[type=file], .assistant-avatar-picker, .assistant-avatar-reset").length'), 0, 'assistant settings offers no static image upload or reset');
    await until('document.querySelector(".assistant-settings-heading .assistant-sprite img")?.naturalWidth>0');
    assert.equal(await read('!!document.querySelector(".assistant-settings-heading .assistant-character").closest("button")'), false, 'the animated preview is not an upload control');
    assert.equal(await read('document.querySelector(".assistant-settings-dialog").getAttribute("aria-labelledby")'), 'assistant-settings-title');
    assert.equal(await read('document.activeElement.name'), 'assistant-name');
    assert.deepEqual(await read('document.querySelector(".composer-surface").getBoundingClientRect().toJSON()'), bounds, 'modal does not move the conversation/composer');
    assert.equal(await read('document.querySelector("textarea[name=assistant-persona]").value'), '');
    assert.match(await read('document.querySelector("textarea[name=assistant-persona]").placeholder'), /温和、可靠/);
    await read('fixture.language("en");void 0');
    await until('document.querySelector("textarea[name=assistant-persona]")?.placeholder.includes("Warm, reliable")');
    assert.equal(await read('document.querySelector("textarea[name=assistant-persona]").value'), '');
    assert.equal(await read('document.querySelector(".assistant-settings-close").getAttribute("aria-label")'), await read('fixture.uiText("en")("assistantSettingsDialog.closeSettings")'));
    win.setContentSize(400, 740);
    await until('document.querySelector(".assistant-settings-dialog").getBoundingClientRect().width<=368');
    assert.ok(await read('(()=>{const n=document.querySelector(".assistant-settings-dialog"),r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&n.scrollWidth<=n.clientWidth;})()'), 'the translated dialog fits a narrow window');
    win.webContents.invalidate(); await pause(250);
    fs.writeFileSync(path.join(directory, 'assistant-settings-narrow.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(1120, 800);
    await read('fixture.language("zh");void 0');
    await until('document.querySelector("textarea[name=assistant-persona]")?.placeholder.includes("温和、可靠")');
    await fill(dialog+' input[name="assistant-name"]', '尚未保存的名称');
    await fill(dialog+' textarea', '尚未保存的交流方式');
    await fill(dialog+' input[name="assistant-name"]', 'Cancelled');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until('!document.querySelector(".assistant-settings-dialog")');
    assert.equal(await read('document.activeElement.title'), '个人资料', 'closing returns focus to the profile trigger');
    assert.equal(await read('document.querySelector(".assistant-view .topbar h1").textContent'), 'assistant');
    await openSettings(); await until('document.querySelector(".assistant-settings-heading .assistant-sprite img")?.naturalWidth>0');
    await fill(dialog+' input[name="assistant-name"]', 'Lumi'); await fill(dialog+' textarea', '温和、可靠');
    win.webContents.invalidate(); await pause(250);
    fs.writeFileSync(path.join(directory, 'assistant-settings-dark.png'), (await win.webContents.capturePage()).toPNG());
    await read('fixture.theme("bright");void 0'); win.webContents.invalidate(); await pause(250);
    fs.writeFileSync(path.join(directory, 'assistant-settings-light.png'), (await win.webContents.capturePage()).toPNG());
    await read('fixture.theme("dark");void 0'); await click(dialog+' button[type=submit]');
    await until('document.querySelector(".assistant-view .topbar h1").textContent==="Lumi"');
    assert.equal(await read('document.querySelectorAll(".assistant-avatar").length'), 0, 'saving settings never revives the old static avatar');
    assert.equal(await read('localStorage.cardbush_personal_assistant_avatar_v1===fixture.legacyAvatar'), true, 'saving preferences leaves legacy user data untouched');
    assert.equal(await read('JSON.stringify(JSON.parse(localStorage.cardbush_personal_assistant_v1)).includes("data:image")'), false, 'images stay out of the inference profile');
    await openSettings();
    assert.equal(await read('document.querySelector("input[name=assistant-name]").value'), 'Lumi');
    assert.equal(await read('document.querySelector("textarea[name=assistant-persona]").value'), '温和、可靠');
    await fill(dialog+' input[name="assistant-name"]', ' '); await click(dialog+' button[type=submit]');
    await until('document.querySelector(".assistant-settings-error")?.textContent===fixture.uiText("zh")("assistantSettingsDialog.enterAName")');
    assert.equal(await read('document.activeElement.name'), 'assistant-name');
    await click(dialog+' .assistant-settings-close');
    await openSettings(); await read('fixture.hide();void 0'); assert.ok(await read('!!document.querySelector(".assistant-settings-dialog:modal")')); await click(dialog+' .assistant-settings-close');
    await read('fixture.show();void 0'); await until('!document.querySelector(".assistant-view").hidden');
    assert.equal(await read('!!document.querySelector(\'[data-nav-section=assistant][aria-label*="Lumi"]\')'), true);
    assert.equal(await read('document.querySelector(".assistant-view .topbar [role=combobox]")===null'), true, 'Assistant no longer mixes local conversation with a separate execution-host selector');
    assert.equal(await read('!!document.querySelector(".assistant-view button[aria-label=员工管理]")'), false, 'the Assistant does not offer team administration');
    await read('fixture.hide();void 0'); await until('document.querySelector(".assistant-view").hidden');
    await read('fixture.show();fixture.busy=true;void 0'); await until('document.querySelector(".assistant-character[data-state=thinking]")');
    const stage = '.sidebar-footer .assistant-stage';
    const stageCue = cue => until(`document.querySelector('${stage} [data-cue=${cue}]')`);
    const checkAction = async (state, row) => {
      await assertAnimatedCharacters(state);
      assert.deepEqual(await read(`Array.from(document.querySelectorAll('${characters}')).map(n=>{
        const image=n.querySelector('img'),animation=image.getAnimations().find(a=>a.animationName==='assistant-sprite-frames');
        if(!animation)return null;
        animation.pause();animation.currentTime=0;const first=getComputedStyle(image).translate;
        animation.currentTime=animation.effect.getTiming().duration/2;
        return [n.style.getPropertyValue('--clip-y'),getComputedStyle(image).imageRendering,first!==getComputedStyle(image).translate];
      })`), [[`${-10*row}%`,'pixelated',true],[`${-10*row}%`,'pixelated',true]], state+' selects and advances its animation in both entry points');
    };
    for (const [row,state] of ['idle','thinking','working','waiting','retrying','error'].entries()) {
      await read(`fixture.activity=${JSON.stringify(state)};void 0`);
      await checkAction(state, row);
    }
    await read('fixture.activity="working";void 0'); await assertAnimatedCharacters('working');
    for (const [offset,state] of ['connecting','listening','speaking','muted'].entries()) {
      await read(`fixture.callPhase(${JSON.stringify(state)});void 0`);
      await checkAction(state, offset+6);
    }
    await read('fixture.callPhase(null);void 0'); await assertAnimatedCharacters('working');
    for (const [mood,gesture] of [['happy','nod'],['curious','glance'],['caring','soften'],['surprised','lift']]) {
      await read(`fixture.expression={mood:'${mood}',replyId:'expression-${mood}',expiresAt:Date.now()+10000};void 0`);
      await until(`document.querySelectorAll('${stage} .robot-expression[data-expression=${mood}][data-gesture=${gesture}] path').length>0`);
      assert.ok(await read(`document.querySelector('.assistant-view .topbar .robot-expression[data-expression=${mood}] path')`), 'the reply expression also reaches the header');
    }
    for (const [tool,prop,gesture] of [
      ['read_file','page','scan'],['edit_file','pencil','write'],['search_plugins','lens','scan'],['terminal_exec','terminal','type'],
      ['linux_computer_use','screen','type'],['web_search','globe','tap'],['check_habit','book','tap'],['view_image','picture','tap'],
      ['assistant_event','clock','tap'],['subagent','team','tap'],['update_task_plan','checklist','tap'],['summary_for_user','bubble','tap'],
      ['await_subagents','hourglass','tap'],['call_tool','plug','tap'],['design','brush','write'],['unknown_tool','wrench','tap'],
    ]) {
      await read(`fixture.toolName='${tool}';void 0`);
      await until(`document.querySelector('${stage} .assistant-tool-prop[data-gesture=${gesture}] [data-tool-prop=${prop}] path')`);
      assert.equal(await read(`document.querySelectorAll('${stage} .assistant-tool-prop').length`), 1, 'switching tools replaces the prop');
      assert.ok(await read(`document.querySelector('.assistant-view .topbar [data-tool-prop=${prop}]')`), tool+' also updates the header');
    }
    await read('fixture.activity="thinking";fixture.toolName="search_plugins";delete fixture.expression;void 0');
    await assertAnimatedCharacters('thinking');
    await until(`document.querySelector('${stage} [data-tool-prop=lens]') && !document.querySelector('${stage} [data-cue=thought]')`);
    await read('delete fixture.toolName;void 0');
    await stageCue('thought');
    await read('document.documentElement.dataset.motionPreference="off";fixture.activity="working";fixture.toolName="terminal_exec";void 0');
    await until(`document.querySelector('${stage} [data-tool-prop=terminal]')`);
    assert.deepEqual(await read(`(() => {
      const actor = document.querySelector('${stage} .assistant-stage-actor');
      const sprite = actor.querySelector('img');
      const [gesture, loop] = sprite.getAnimations();
      fixture.workLoop = loop;
      const timing = loop.effect.getTiming();
      gesture.finish(); loop.pause(); loop.currentTime = timing.delay + timing.duration * 0.5;
      return [gesture.effect.getTiming().iterations, timing.iterations === Infinity, actor.getAnimations().length, getComputedStyle(sprite).translate];
    })()`), [2, true, 0, '-12.5%'], 'two opening gestures lead into a small, repeating frame change without moving the actor');
    await read('fixture.theme("bright");void 0');
    await until('document.querySelector(".app.theme-bright")');
    assert.ok(await read(`document.querySelector('${stage} img').getAnimations().includes(fixture.workLoop)`), 'a theme change does not restart the gesture');
    await read('fixture.toolName="edit_file";fixture.expression={mood:"happy",replyId:"reply-1",expiresAt:Date.now()+3100};void 0');
    await until(`document.querySelector('${stage}[data-state=working] [data-expression=happy]') && document.querySelector('${stage} [data-tool-prop=pencil]')`);
    const propStyle = `getComputedStyle(document.querySelector('${stage} .assistant-tool-prop'))`;
    await read('document.documentElement.dataset.windowVisible="false";void 0');
    assert.equal(await read(`${propStyle}.animationPlayState`), 'paused', 'props pause in a hidden window');
    assert.ok(await read(`getComputedStyle(document.querySelector('${stage} .assistant-sprite img')).animationPlayState.split(',').every(s=>s.trim()==='paused')`), 'the character pauses with its props');
    await read('delete document.documentElement.dataset.windowVisible;document.documentElement.dataset.motionPreference="on";void 0');
    assert.equal(await read(`${propStyle}.animationName`), 'none', 'the tool remains legible without motion');
    assert.ok(await read(`getComputedStyle(document.querySelector('${stage} .assistant-sprite img')).animationName.split(',').every(s=>s.trim()==='none')`), 'reduced motion retains a static character pose');
    await until(`!document.querySelector('${stage} .robot-expression') && document.querySelector('${stage}[data-state=working] [data-tool-prop=pencil]')`);
    await read('fixture.changeSkin(true);void 0');
    await until(`document.querySelector('${stage} .assistant-tool-prop[data-gesture=scan] [data-tool-prop=pencil] path')?.getAttribute('d')==='M1 1h3v3H1z'`);
    assert.equal(await read(`${propStyle}.getPropertyValue('--prop-x')`), '10%', 'a replacement skin controls placement, drawing and gesture without changing the tool');
    await read('fixture.changeSkin(false);void 0');
    await read('delete document.documentElement.dataset.motionPreference;void 0');
    await read('fixture.activity="waiting";void 0');
    await stageCue('hourglass');
    assert.equal(await read(`!!document.querySelector('${stage} .assistant-tool-prop')`), false, 'waiting does not pretend to execute a tool');
    assert.equal(await read(`!!document.querySelector('${stage} .robot-expression')`), false, 'waiting clears the transient expression');
    await read('delete fixture.activity;delete fixture.expression;delete fixture.toolName;fixture.theme("dark");void 0');
    await stageCue('thought');
    assert.equal(await read('localStorage.cardbush_personal_assistant_avatar_v1===fixture.legacyAvatar'), true, 'all animation regressions ran with the old avatar still saved');
    console.log('Assistant character passed: legacy avatar ignored, animated settings, actions, expressions, props and stage cues.');
};
