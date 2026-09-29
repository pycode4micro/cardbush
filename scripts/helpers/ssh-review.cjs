const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.sshRoot='ssh://saved-connection/home/ubuntu';
    window.sshFile=sshRoot+'/service.ts';
    window.sshReads=[]; window.sshOpens=[]; window.branchCalls=0;
    cardbushDesktop.readTextPreview=async path=>{sshReads.push(path);return {path,content:'export const remote = "SSH preview works";',encoding:'utf-8',truncated:false};};
    cardbushDesktop.readWorkspaceDirectory=async()=>({entries:[{name:'service.ts',path:sshFile,kind:'file'}]});
    cardbushDesktop.gitInfo=async()=>({branch:'',root:sshRoot,changedFiles:[],missing:true});
    cardbushDesktop.gitBranches=async()=>{branchCalls++;throw Error('Should not query a non-repository');};
    addEventListener('cardbush:open-inspector',event=>{sshOpens.push(event.detail);preview(event.detail.target);});
    renderView(h(views.LocalFileReferenceLink,{path:views.markdownLocalFileReference('/home/ubuntu/service.ts',sshRoot).path}));
  `);
  await until("!!document.querySelector('a.local-file-reference')", 'SSH reference resolves');
  assert.match(await run("document.querySelector('a.local-file-reference').href"), /^cardbush-file:\/\/ssh-file\//);
  await run("document.querySelector('a.local-file-reference').click()");
  await until("document.querySelector('.source-inspector-preview')?.textContent.includes('SSH preview works')", 'SSH source preview');
  assert.equal(await run('sshOpens[0].target'), 'ssh://saved-connection/home/ubuntu/service.ts');
  assert.ok((await run('sshReads')).every(value => value.startsWith('ssh://')), 'no local reinterpretation');
  await run("renderView(h(views.GitBranchMenu,{language:'zh',activeProjectDir:sshRoot}))");
  await until("document.body.textContent.includes('此目录不是 Git 仓库')", 'non-Git directory state');
  assert.equal(await run('branchCalls'), 0);
  assert.equal(await run("document.querySelector('.branch-create-row button').disabled"), true);
  assert.equal(await run("document.body.textContent.includes('fatal:')"), false);
  await run(`
    window.sshReports=views.changeReportsFromMessages([
      {id:'user',role:'user',content:'修改远程文件',turnId:'ssh-turn'},
      {id:'assistant',role:'assistant',content:'',turnId:'ssh-turn',toolExecutions:[{
        id:'edit',name:'edit_file',state:'completed',summary:'',output:'',success:true,metadata:{workspaceChanges:[{
          path:sshFile,additions:1,deletions:1,metadata:{diff:'@@ -1 +1 @@\\n-old remote line\\n+new remote line',revertSupported:false}
        }]}
      }]}
    ]);
    window.renderSshReview=()=>renderView(h('aside',{className:'right-inspector',style:{height:'100%',width:'850px',maxWidth:'none',flex:'none'}},h(views.ConversationChangeDialog,{
      embedded:true,language:'zh',conversation:{id:'ssh-chat',title:'远程审查',projectDir:sshRoot},reports:sshReports,
      initialFilePath:sshFile,notice:'',revertingChangeId:'',revertedChangeIds:new Set(),onClose:()=>{},onRevert:async()=>{throw Error('Remote revert must be disabled');}
    })));
    renderSshReview();
  `);
  await until("document.querySelector('.change-review-diff-pane')?.textContent.includes('new remote line')", 'SSH recorded diff');
  assert.equal(await run("document.querySelector('.change-review-revert').disabled"), true);
  assert.ok(await run("document.querySelector('.change-review-diff-pane').textContent.includes('old remote line')"));
  for (const theme of ['dark', 'bright']) {
    await run(`viewTheme='theme-${theme}';renderSshReview();`);
    await pause(150);
    fs.writeFileSync(path.join(root, 'tmp', 'ssh-review-' + theme + '.png'), (await window.capturePage()).toPNG());
  }
};
