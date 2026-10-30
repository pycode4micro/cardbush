const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ read, until, fill, click, pause, win, directory }) => {
  await read(`fixture.management={permissions:[],plan:{revision:1,plan:{protocol:'bush.task_plan.v1',plan_id:'overall',session_id:'personal-assistant',active:true,
    nodes:[{id:'prepare',step:'Prepare the report',status:'in_progress'},{id:'deliver',step:'Deliver the report',status:'pending'}],explanation:'Overall work'}}};void 0`);
  await click('[data-work-summary-toggle]');
  await until('document.querySelector(".work-summary-plan")?.textContent.includes("Prepare the report")');
  assert.equal(await read('document.querySelectorAll(".work-summary-plan li").length'), 2);
  await read('fixture.management.plan.revision++;fixture.management.plan.plan.nodes[0].status="completed";void 0');
  await until('!!document.querySelector(".work-summary-plan li.completed")');
  await read('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));void 0');
  await fill('textarea', 'Keep my draft while approving');
  const show = async id => {
    await read(`fixture.management.permissions=[{permissionId:${JSON.stringify(id)},toolCallId:'schedule-call',sessionId:'personal-assistant',turnId:'parent-turn',request:{
      reason:'Approve this scheduled report',actions:['schedule.create'],targets:[{kind:'path',value:'C:/fixture/report.html'}],requestedCapabilityIds:['schedule.create'],scope:{mode:'task_free',roots:['C:/fixture']}}}];void 0`);
    await until('!!document.querySelector(".permission-request-card")');
    assert.equal(await read('document.querySelectorAll(".permission-request-card").length'), 1);
    assert.equal(await read('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")'), 'true', 'the scroll control does not cover the approval card');
  };
  for (const [index, decision] of ['allow_once', 'allow_session', 'deny', 'cancel'].entries()) {
    await show('approval-' + index);
    if (index === 0) {
      await read('fixture.failPermission=true;void 0'); await click('.permission-action.allow');
      await until('document.querySelector(".permission-request-error")?.textContent.includes("Approval connection failed")');
      assert.equal(await read('(fixture.permissionAnswers??[]).length'), 0);
      await read('fixture.failPermission=false;void 0');
    }
    if (index === 1) {
      await read('fixture.portal(true);void 0');
      await until('!!document.querySelector(".inspector-quick-input .permission-request-card")');
    }
    await click(decision === 'cancel' ? '.permission-request-card header button' : '.permission-action.' + ({ allow_once: 'allow', allow_session: 'session', deny: 'deny' }[decision]));
    await until('!document.querySelector(".permission-request-card")');
    assert.equal(await read('fixture.permissionAnswers.at(-1).decision'), decision);
    assert.equal(await read('document.querySelector("textarea").value'), 'Keep my draft while approving');
  }
  await read('fixture.portal(false);void 0');
  for (const theme of ['dark', 'bright']) {
    await read('fixture.theme(' + JSON.stringify(theme) + ');void 0'); win.setSize(680, 760);
    await show('layout-' + theme); await pause(100);
    await read('fixture.language("en");void 0');
    await until('document.querySelector(".permission-action.allow span")?.textContent===fixture.uiText("en")("permission.allow_once")');
    await read('fixture.language("zh");void 0');
    await until('document.querySelector(".permission-action.allow span")?.textContent===fixture.uiText("zh")("permission.allow_once")');
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
    const bounds = await read('(()=>{const r=document.querySelector(".permission-request-card").getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}})()');
    assert.ok(bounds.left >= 0 && bounds.right <= 680 && bounds.bottom <= 760, JSON.stringify(bounds));
    fs.writeFileSync(path.join(directory, 'assistant-management-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
    await click('.permission-request-card header button'); await until('!document.querySelector(".permission-request-card")');
  }
  await read('fixture.management.plan=undefined;void 0'); await click('[data-work-summary-toggle]');
  await until('!!document.querySelector(".conversation-work-summary")&&!document.querySelector(".work-summary-plan")');
  console.log('Assistant management UI passed: live overall plan, approval/deny/cancel/error recovery, portal, preserved draft and responsive themes. Screenshots: ' + directory);
};
