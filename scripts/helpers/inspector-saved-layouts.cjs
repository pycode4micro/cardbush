const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/inspector/inspectorWorkspace.css'), 'utf8'));
  await run(`
    crypto.randomUUID=require('node:crypto').randomUUID;
    window.confirm=()=>{throw Error('Unexpected confirmation');};
    function LayoutFixture(){
      const tabs=views.useInspectorTabs();
      const [section,setSection]=React.useState('chat'),[sidebarCollapsed,setSidebarCollapsed]=React.useState(false),[inspectorOpen,setInspectorOpen]=React.useState(true),[saving,setSaving]=React.useState(null);
      const workspace=views.useInspectorWorkspace({language:'zh',windowMaximized:false,compactLayout:false,section,setSection,sidebarCollapsed,sidebarWidth:280,setSidebarCollapsed,
        inspectorOpen,setInspectorOpen,inspectorTabs:tabs.tabs,activeInspectorTab:tabs.activeTab,openInspectorTab:tabs.openTab,setInspectorTabsMenuOpen:()=>{}});
      const open=saved=>{const restored=views.restoreInspectorLayout(saved,tabs.tabs,{});workspace.openMultiPage(restored.tabs,restored.layout);};
      const save=()=>setSaving({snapshot:views.captureInspectorLayout(workspace.inspectorLayout,tabs.tabs,{})});
      window.layoutFixture={tabs,workspace};
      return h('div',{style:{width:620}},h(views.InspectorActions,{language:'zh',filesAvailable:true,shadowUnavailableReason:'',onOpenFiles:()=>{},onOpenShadow:()=>{},
        onMultiPage:workspace.toggleMultiPage,multiPage:!!workspace.inspectorLayout,onSaveLayout:save,onOpenLayout:open}),
        h('div',{style:{height:200,position:'relative'}},h(views.InspectorTabPages,{tabs:tabs.tabs,activeId:tabs.activeId,layout:workspace.inspectorLayout,
          children:tab=>h('input',{'data-page-input':tab.id,defaultValue:tab.detail.target})})),
        saving&&h(views.InspectorLayoutDialog,{language:'zh',snapshot:saving.snapshot,onClose:()=>setSaving(null)}));
    }
    window.mountLayoutFixture=()=>renderView(h(LayoutFixture)); mountLayoutFixture();
  `);
  const name = async value => run(`(()=>{const input=document.querySelector('.inspector-layout-dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until("!!document.querySelector('[data-inspector-action=multi-page]')", 'multipage action');
  await run("document.querySelector('[data-inspector-action=multi-page]').click()");
  await until('layoutFixture.tabs.tabs.length===2 && !!layoutFixture.workspace.inspectorLayout', 'immediate multipage entry');
  await run("layoutFixture.workspace.setInspectorLayout(tree=>({...tree,ratio:.65}));document.querySelector('[data-inspector-action=save-layout]').click()");
  await until("!!document.querySelector('.inspector-layout-dialog[open]')", 'save dialog');
  // Capture after the geometry change has committed.
  await run("document.querySelector('.inspector-layout-dialog button[type=button]').click()");
  await until("!document.querySelector('.inspector-layout-dialog')", 'cancel only closes save dialog');
  await run("document.querySelector('[data-inspector-action=save-layout]').click()");
  await until("!!document.querySelector('.inspector-layout-dialog[open]')", 'save current geometry');
  await name('研究工作台');
  await run("document.querySelector('.inspector-layout-dialog form').requestSubmit()");
  await until("!!document.querySelector('.inspector-saved-layout-open') && !document.querySelector('dialog')", 'saved layout appears in tools');
  assert.equal(await run("JSON.parse(localStorage.getItem('cardbush.inspector_layouts.v1'))[0].layout.ratio"), .65);
  await run('renderView(null)'); await pause(); await run('mountLayoutFixture()');
  await until("!!document.querySelector('.inspector-saved-layout-open')", 'saved tool survives remount');
  assert.equal(await run('layoutFixture.tabs.tabs.length'), 0);
  await run("document.querySelector('.inspector-saved-layout-open').click()");
  await until('layoutFixture.tabs.tabs.length===2 && layoutFixture.workspace.inspectorLayout?.ratio===.65', 'one click restores pages and proportions');
  await run("window.retainedLayoutInput=document.querySelector('[data-page-input]');retainedLayoutInput.value='Unsaved draft';document.querySelector('.inspector-saved-layout-open').click()");
  await pause();
  assert.equal(await run("document.querySelector('[data-page-input]')===retainedLayoutInput && retainedLayoutInput.value==='Unsaved draft'"), true, 'repeat opening retains mounted page state');
  assert.equal(await run('layoutFixture.tabs.tabs.length'), 2);
  for (const theme of ['theme-dark','theme-bright']) {
    await run(`window.viewTheme=${JSON.stringify(theme)};mountLayoutFixture()`); await pause();
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
    fs.writeFileSync(path.join(root,'tmp', 'saved-layout-'+theme+'.png'),(await window.webContents.capturePage({x:0,y:0,width:620,height:650})).toPNG());
  }
  await run("document.querySelector('.inspector-saved-layout-edit').click()");
  await until("!!document.querySelector('.inspector-layout-dialog[open]')", 'edit saved tool');
  await name('我的布局'); await run("document.querySelector('.inspector-layout-dialog form').requestSubmit()");
  await until("document.querySelector('.inspector-saved-layout-open strong')?.textContent==='我的布局'", 'rename updates tool');
  await run("document.querySelector('.inspector-saved-layout-edit').click()");
  await until("!!document.querySelector('.inspector-layout-dialog[open]')", 'reopen edit');
  await run("document.querySelector('.inspector-layout-delete').click()");
  await until("!document.querySelector('.inspector-saved-layout')", 'delete removes saved tool');
  assert.equal(await run('layoutFixture.tabs.tabs.length'),2,'deleting a shortcut leaves its live pages open');
  console.log('Saved multipage UI passed: no confirmation, named save, persistent tool, one-click restore, ratios, live page reuse, rename and delete.');
};
