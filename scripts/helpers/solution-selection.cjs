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
  await run(`
    window.batchChoice = {...choice,id:'solution-batch',raw:{questions:[]},questions:[
      {...choice.questions[0],id:'version'},
      {id:'period',label:'时间',question:'采用哪个统计时间范围',options:[{id:'0',label:'最近七天'}]},
      {id:'format',label:'格式',question:'选择导出格式',options:[{id:'0',label:'CSV'},{id:'1',label:'Excel'}]}
    ]}; updateChat({pendingInteraction:batchChoice});
  `);
  await until('!!document.querySelector(".solution-selection-steps")', 'multi-question navigation');
  const next = () => run(`document.querySelector('.solution-selection-actions button').click()`);
  const prev = () => run(`document.querySelector('[aria-label="上一题"]').click()`);
  assert.equal(await run('document.querySelector(".solution-selection-actions button").disabled'), true, 'no default answer');
  await run(`document.querySelector('[aria-label="下一题"]').click()`);
  await until('document.querySelector(".solution-selection-steps span").textContent.includes("2 / 3")', 'unanswered second question can be inspected');
  await run(`document.querySelector('[aria-label="下一题"]').click()`);
  await until('document.querySelector(".solution-selection-steps span").textContent.includes("3 / 3")', 'unanswered final question');
  await run(`document.querySelectorAll('.solution-selection-options button')[1].click()`);
  assert.equal(await run('document.querySelector(".solution-selection-actions button").disabled'), true, 'cannot submit missing first answers');
  await prev(); await prev();
  await until('document.querySelector(".solution-selection-steps span").textContent.includes("1 / 3")', 'return to first question');
  await run(`document.querySelectorAll('.solution-selection-options button')[0].click()`);
  assert.equal(await run('solutionReplies.length'), 2, 'choosing an option does not post a partial reply');
  await next(); await type('上个月，按实际日期统计');
  await next(); await prev();
  assert.equal(await run('document.querySelector(".solution-selection-custom textarea").value'), '上个月，按实际日期统计');
  await prev();
  assert.equal(await run('document.querySelectorAll(".solution-selection-options button")[0].getAttribute("aria-pressed")'), 'true');
  await run(`document.querySelectorAll('.solution-selection-options button')[1].click()`);
  await next(); await next();
  await run(`updateChat({activeConversationId:'session-b'})`);
  await until('!document.querySelector(".solution-selection-card")', 'hide batch in other conversation');
  await run(`updateChat({activeConversationId:'session-a'})`);
  await until('document.querySelector(".solution-selection-steps span")?.textContent.includes("3 / 3")', 'restore step and all draft answers');
  assert.equal(await run('document.querySelectorAll(".solution-selection-options button")[1].getAttribute("aria-pressed")'), 'true');
  assert.equal(await run('document.querySelector(".solution-selection-actions button").disabled'), false);
  await run('failSolution=true'); await next();
  await until('!!document.querySelector(".solution-selection-error")', 'batch failure is retryable');
  assert.equal(await run('solutionReplies.length'), 2);
  await run(`failSolution=false;window.solutionAttempts=0;window.solutionPreviousTitle=chatProps.title;
    updateChat({title:'Atomic solution submission',onReplyInteraction:async answers=>{
    solutionAttempts++;await new Promise(resolve=>window.finishSolution=resolve);solutionReplies.push(answers);updateChat({pendingInteraction:null});
  }});`);
  // Updating root props schedules a React commit. Wait for that same render's
  // visible title before clicking, or the old reply handler can finish the card.
  await until("document.body.innerText.includes('Atomic solution submission')", 'new reply handler committed');
  await run(`document.querySelector('.solution-selection-actions button').click();document.querySelector('.solution-selection-actions button').click()`);
  await until('solutionAttempts===1', 'one atomic submission');
  assert.equal(await run('document.querySelector(".solution-selection-steps button").disabled'), true, 'cannot edit during submit');
  await run('finishSolution()');
  await until('solutionReplies.length===3 && !document.querySelector(".solution-selection-card")', 'all answers submitted together');
  assert.deepEqual(await run('solutionReplies[2]'), [
    {questionId:'version',selectedOptionId:'1'}, {questionId:'period',text:'上个月，按实际日期统计'}, {questionId:'format',selectedOptionId:'1'}
  ]);
  assert.equal(await run('chatProps.draft'), '未发送的会话草稿');
  await run(`updateChat({pendingInteraction:{...batchChoice,id:'solution-batch-cancel'}})`);
  await until('!!document.querySelector(".solution-selection-steps")', 'batch cancel fixture');
  await run(`document.querySelectorAll('.solution-selection-options button')[0].click()`);
  await next(); await type('暂存的范围');
  await capture('theme-dark', 'solution-selection-multi-dark.png');
  await capture('theme-bright', 'solution-selection-multi-light.png');
  window.setSize(540,760); await pause();
  assert.ok(await run('document.querySelector(".solution-selection-card").scrollWidth <= document.querySelector(".solution-selection-card").clientWidth'), 'multi-question card fits narrow windows');
  await run(`document.querySelector('.solution-selection-card header > button').click()`);
  await until('solutionCancels===2 && !document.querySelector(".solution-selection-card")', 'cancel discards the entire batch');
  assert.equal(await run('solutionReplies.length'), 3, 'cancel never publishes partial answers');
  window.setBounds(bounds);
  await run(`document.querySelector('.app').className='app theme-dark';updateChat({title:solutionPreviousTitle,language:'en',draft:'',sending:false,pendingInteraction:null,onReplyInteraction:async()=>{},onCancelInteraction:async()=>{}})`);
  console.log('Solution Selection UI passed: single-question compatibility, multi-step navigation, all drafts preserved across sessions, atomic submit/retry, missing answers, duplicate-submit guard, cancellation, light/dark and narrow layout.');
};
