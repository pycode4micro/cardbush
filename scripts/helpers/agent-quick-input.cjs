const assert = require('node:assert/strict');
module.exports = async ({run,until,pause}) => {
  await run(`
    snapshots.a=[normalizeSession({sessionId:'a1',revision:1,metadata:{title:'Quick cloud',projectId:'project-a'},turns:[]})];
    [...document.querySelectorAll('.fixture-nav button')].find(button=>button.textContent==='a1').click();undefined;
  `);
  await until('!!document.querySelector(".agent-chat .welcome-composer textarea")','cloud composer');
  await pause(150);
  await run(`
    var field=document.querySelector('.agent-chat textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Cloud draft');field.dispatchEvent(new Event('input',{bubbles:true}));
    window.quickTarget=document.createElement('div');quickTarget.className='inspector-quick-input';quickTarget.style='position:fixed;bottom:30px;left:100px;right:100px;z-index:200';document.querySelector('.app').append(quickTarget);fixtureComposerTarget(quickTarget);undefined;
  `);
  await until('!!quickTarget.querySelector("textarea")','cloud Composer moved to capsule');
  assert.equal(await run('quickTarget.querySelector("textarea").value'),'Cloud draft');
  assert.equal(await run('document.querySelectorAll("[data-composer-input]").length'),1,'only active cloud composer moves');
  await run('quickTarget.querySelector(".send-button").click();undefined;');
  await until('calls.some(c=>c.operation==="chat.send")','cloud API receives message');
  assert.deepEqual(await run('calls.filter(c=>c.operation==="chat.send").map(c=>[c.id,c.input.sessionId])'),[['a','a1']]);
  await until('quickTarget.querySelector("textarea")?.value===""','cloud admission clears capsule draft');
  await run('fixtureComposerTarget(null);undefined;');
  await until('!!document.querySelector(".agent-chat textarea") && !quickTarget.querySelector("textarea")','cloud composer returns to same conversation');
  assert.ok(await run('document.querySelector(".agent-chat .message-list").textContent.includes("Cloud draft")'));
  await pause(100);
  console.log('Cloud quick input passed: original host/session/draft, single Composer, remote admission, and return without local Runtime dispatch.');
};
