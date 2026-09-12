const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Team UI timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const read = script => win.webContents.executeJavaScript(script);
  const until = async script => {
    const end = Date.now() + 4000;
    while (!(await read(script))) {
      if (Date.now() > end) throw Error('Timed out: ' + script + '; ' + await read('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    await win.loadFile(join(directory, 'index.html'));
    await until('!!document.querySelector(".team-agent-editor")');
    assert.equal(await read('document.querySelectorAll(".team-sidebar-embedded").length'), 1);
    assert.equal(await read('document.querySelectorAll(".team-back-button,.settings-dock").length'), 0);
    await read('window.newTeam=actions.createTeam("zh"); actions.saveTeam(newTeam)');
    await until('receipt.configuration.teams.length===2 && !teamState.saving');
    assert.equal(await read('receipt.configuration.profiles.length'), 2);
    await read('window.profileId=teamState.profiles[0].id; actions.updateProfile(profileId,{prompts:{instructions:"First draft"}}); deferSave=true; void actions.saveTeam(newTeam)');
    await until('typeof finishSave==="function"');
    await read('actions.updateProfile(profileId,{prompts:{instructions:"Edited during save"}}); finishSave(); deferSave=false');
    await until('!teamState.saving');
    assert.equal(await read('receipt.configuration.profiles[0].prompts.instructions'), 'First draft');
    assert.equal(await read('teamState.profiles[0].prompts.instructions'), 'Edited during save');
    assert.equal(await read('teamState.dirtyProfileIds.has(profileId)'), true);
    await read('receipt.contentHash="90"; receipt.configuration.profiles[0].prompts.instructions="External editor"; actions.saveTeam(newTeam).catch(()=>{})');
    await until('teamState.error.includes("changed on disk")');
    assert.equal(await read('receipt.configuration.profiles[0].prompts.instructions'), 'External editor');
    await read('actions.refresh()');
    await until('teamState.configurationHash==="90"');
    await read('actions.deleteTeam(newTeam)');
    await until('receipt.configuration.teams.length===1');
    assert.equal(await read('teamState.configurationHash'), await read('receipt.contentHash'));
    await read('actions.updateTeam("general",{name:"After delete"}); actions.saveTeam("general")');
    await until('receipt.configuration.teams[0].name==="After delete"');
    await read('importValue=structuredClone(receipt.configuration); importValue.teams[0].name="Imported YAML"; actions.importFile()');
    await until('teamState.teams[0].name==="Imported YAML"');
    await read('actions.exportFile(); actions.revealFile()');
    await until('exports.length===1 && reveals===1');
    assert.equal(await read('exports[0].configuration.teams[0].name'), 'Imported YAML');
    for (const width of [1100, 760]) {
      win.setSize(width, 850);
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true, 'Team workspace fits width ' + width);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { writeFileSync(resolve('tmp/team-plugin-workspace.png'), (await win.webContents.capturePage()).toPNG()); break; }
      catch (error) {
        if (attempt === 2 || !String(error).includes('UnknownVizError')) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    console.log('Team UI passed: member navigation, atomic save, edits during save, file conflicts, delete/save, import/export/reveal and narrow layout.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
