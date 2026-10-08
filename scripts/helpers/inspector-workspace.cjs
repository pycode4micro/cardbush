const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    // The data: fixture is not a secure context; supply the native implementation.
    window.workspaceRandomUUID=crypto.randomUUID; crypto.randomUUID=require('node:crypto').randomUUID;
    window.workspaceConfirm=window.confirm; window.confirm=()=>{throw Error('Multipage must not ask for confirmation');};
    localStorage.setItem('cardbush.inspector_width','560');
    function WorkspaceFixture(){
      const [section,setSection]=React.useState('automations'),[sidebarCollapsed,setSidebarCollapsed]=React.useState(false);
      const [inspectorOpen,setInspectorOpen]=React.useState(true),[inspectorTabs,setTabs]=React.useState([]);
      const [tabsMenu,setInspectorTabsMenuOpen]=React.useState(true);
      const openInspectorTab=React.useCallback(tab=>setTabs(current=>[...current,tab]),[]);
      const workspace=views.useInspectorWorkspace({language:'zh',windowMaximized:false,compactLayout:false,
        section,setSection,sidebarCollapsed,sidebarWidth:280,setSidebarCollapsed,inspectorOpen,setInspectorOpen,
        inspectorTabs,activeInspectorTab:inspectorTabs[0]||null,openInspectorTab,setInspectorTabsMenuOpen});
      window.workspaceFixture={...workspace,section,setSection,sidebarCollapsed,inspectorOpen,setInspectorOpen,inspectorTabs,setTabs,tabsMenu};
      return h('div',null,'Workspace lifecycle');
    }
    renderView(h(WorkspaceFixture));
  `);
  try {
    await until('!!window.workspaceFixture','workspace hook mounted');
    const failure = await run('try { workspaceFixture.toggleMultiPage(); null } catch (error) { error.stack }');
    assert.equal(failure, null);
    await until('workspaceFixture.inspectorTabs.length===2 && !!workspaceFixture.inspectorLayout','two panes created');
    assert.deepEqual(await run('[workspaceFixture.sidebarCollapsed,workspaceFixture.tabsMenu]'),[true,false]);
    await run('workspaceFixture.enterInspectorCover()'); await pause();
    await run("workspaceFixture.setQuickInputOpen(true);workspaceFixture.setSection('chat')"); await pause();
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await pause();
    assert.equal(await run('workspaceFixture.quickInputOpen'),false);
    assert.equal(await run('workspaceFixture.inspectorCover'),true,'first Escape closes only quick input');
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await pause();
    assert.equal(await run('workspaceFixture.section'),'automations','cover returns to the prior section');
    assert.equal(await run('workspaceFixture.inspectorCover'),false);
    await run('workspaceFixture.setTabs(current=>current.slice(0,1))');
    await until('workspaceFixture.inspectorLayout===null','one remaining page leaves multipage');
    assert.equal(await run('workspaceFixture.inspectorWidth'),560,'saved width restored');
    assert.equal(await run('workspaceFixture.sidebarCollapsed'),false,'saved sidebar restored');
    await run('workspaceFixture.enterInspectorCover()'); await pause();
    await run("workspaceFixture.setQuickInputOpen(true);workspaceFixture.setSection('chat')"); await pause();
    await run('workspaceFixture.revealConversation()'); await pause();
    assert.equal(await run('workspaceFixture.section'),'chat','expanding quick input keeps its current conversation instead of the old feature page');
    assert.equal(await run('workspaceFixture.inspectorCover || workspaceFixture.quickInputOpen'),false);
    await run('workspaceFixture.enterInspectorCover()'); await pause();
    await run('workspaceFixture.setInspectorOpen(false)');
    await until('!workspaceFixture.inspectorCover','closing inspector releases cover');
    await run('renderView(null)'); await pause();
    assert.equal(await run('document.body.classList.contains("window-right-edge-resizing")'),false);
    console.log('Inspector workspace ownership passed: immediate pane creation without confirmation, menu closure, Escape, section/sidebar/width restore and close cleanup.');
  } finally { await run('window.confirm=workspaceConfirm; crypto.randomUUID=workspaceRandomUUID; void 0'); }
};
