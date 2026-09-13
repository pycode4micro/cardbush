const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/interactions/solutionSelection.css'), 'utf8'));
  await run(`
    window.solutionReplies = []; window.solutionCancels = 0; window.failSolution = false;
    window.choice = { id:'solution-a',type:'solution_selection',sessionId:'session-a',turnId:'turn-a',
      title:'Solution Selection',toolName:'solution_selection',raw:{},
      questions:[{id:'solution',label:'Solution Selection',question:'数据冲突如何处理',options:[
        {id:'0',label:'保留现有数据（推荐）'},{id:'1',label:'使用新数据'},{id:'2',label:'分别保留两份'}]}]};
    updateChat({ language:'zh', draft:'未发送的会话草稿', sending:true, activeTurnId:'turn-a', pendingInteraction:choice,
      onReplyInteraction:async answers=>{ if(failSolution)throw Error('连接暂时不可用'); solutionReplies.push(answers); updateChat({pendingInteraction:null}); },
      onCancelInteraction:async()=>{solutionCancels++;updateChat({pendingInteraction:null});} });
  `);
  await until('!!document.querySelector(".solution-selection-card")', 'solution replaces composer');
  assert.equal(await run('document.querySelectorAll(".composer-surface").length'), 0, 'ordinary chat composer is absent');
  assert.equal(await run('document.querySelectorAll(".solution-selection-options button").length'), 3);
  assert.equal(await run('document.querySelectorAll(".solution-selection-card textarea").length'), 1, 'own alternative input remains');
  await pause(); assert.equal(await run('solutionReplies.length'), 0, 'recommended text does not auto-submit');
  const type = value => run(`(() => {const node=document.querySelector('.solution-selection-custom textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await type('先备份，再合并');
  await run(`updateChat({activeConversationId:'session-b'})`);
  await until('!document.querySelector(".solution-selection-card") && !!document.querySelector(".composer-surface")', 'foreign session never hides its composer');
  await run(`updateChat({activeConversationId:'session-a'})`);
  await until('!!document.querySelector(".solution-selection-card")', 'original decision restored');
  assert.equal(await run('document.querySelector(".solution-selection-custom textarea").value'), '先备份，再合并');
  await run(`failSolution=true;document.querySelector('.solution-selection-custom button').click()`);
  await until('!!document.querySelector(".solution-selection-error")', 'failed answer remains actionable');
  assert.equal(await run('document.querySelector(".solution-selection-custom textarea").value'), '先备份，再合并');
  await run(`failSolution=false;document.querySelector('.solution-selection-custom button').click()`);
  await until('!document.querySelector(".solution-selection-card")', 'answer restores chat composer');
  assert.deepEqual(await run('solutionReplies[0]'), [{ questionId:'solution', text:'先备份，再合并' }]);
  assert.equal(await run('chatProps.draft'), '未发送的会话草稿');
  await run(`updateChat({pendingInteraction:{...choice,id:'solution-option'}})`);
  await until('!!document.querySelector(".solution-selection-options")', 'next selection');
  await run('document.querySelectorAll(".solution-selection-options button")[1].click()');
  await until('solutionReplies.length===2', 'option sent once');
  assert.deepEqual(await run('solutionReplies[1]'), [{ questionId:'solution', selectedOptionId:'1' }]);
  await run(`updateChat({pendingInteraction:{...choice,id:'solution-cancel'}})`);
  await until('!!document.querySelector(".solution-selection-card")', 'cancel fixture');
  const capture = async (theme, name) => {
    await run(`document.querySelector('.app').className='app ${theme}';`); await pause();
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true}); fs.writeFileSync(path.join(root,'tmp',name),(await window.webContents.capturePage()).toPNG());
  };
  await capture('theme-dark', 'solution-selection-dark.png');
  await capture('theme-bright', 'solution-selection-light.png');
  const bounds = window.getBounds(); window.setSize(540,760); await pause();
  assert.ok(await run('document.querySelector(".solution-selection-card").scrollWidth <= document.querySelector(".solution-selection-card").clientWidth'), 'narrow selection has no horizontal overflow');
  await run('document.querySelector(".solution-selection-card header button").click()');
  await until('solutionCancels===1 && !document.querySelector(".solution-selection-card")', 'dismiss restores composer');
  assert.equal(await run('solutionReplies.length'), 2, 'dismissal does not select a default');
  window.setBounds(bounds);
  await run(`document.querySelector('.app').className='app theme-dark';updateChat({language:'en',draft:'',sending:false,pendingInteraction:null,onReplyInteraction:async()=>{},onCancelInteraction:async()=>{}})`);
  console.log('Solution Selection UI passed: scoped composer replacement, preserved drafts, option/free text replies, failure retry, dismissal, light/dark and narrow layout.');
};
