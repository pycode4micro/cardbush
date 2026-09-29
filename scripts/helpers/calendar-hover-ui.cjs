const assert = require('node:assert/strict');

module.exports = async ({ read, until, win, capture }) => {
  const move = async selector => {
    const point = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  };
  const visible = '!!document.querySelector(".calendar-day-details:popover-open")';
  const checkBounds = () => read('(()=>{const r=document.querySelector(".calendar-day-details").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()');
  win.setSize(1100,900);
  await until('innerWidth>1000');
  await read(`{
    const today=fixtureKey(fixtureDay);
    calendarState={chineseLunar:true,datasets:[...calendarState.datasets.filter(item=>item.builtin).map(item=>({...item,enabled:item.calendar.id==='cardbush.chinese'})),{enabled:true,calendar:{protocol:'cardbush.calendar.v1',id:'hover-test',name:'测试节日',timeZone:'Asia/Shanghai',entries:[
      {id:'holiday',date:today,title:'节日示例',kind:'holiday',description:'鼠标悬浮可见的节日说明'},
      {id:'ongoing',date:fixtureKey(new Date(fixtureAt(-1,0))),endDate:fixtureKey(new Date(fixtureAt(1,0))),title:'跨日安排',kind:'event'}]}}]};
    window.hoverMutations=calls.filter(c=>c.action!=='list').length;
    renderCalendarWidgets('zh',2);
  }`);
  await until('document.querySelectorAll(".builtin-calendar").length===2');
  await until('!!document.querySelector(".builtin-calendar [aria-current=date] .calendar-day-dot")');
  assert.equal(await read('listeners.size'), 1, 'multiple widgets share one scheduler subscription');
  assert.equal(await read('document.querySelectorAll(".calendar-lunar-date,.calendar-day-details").length'), 0, 'details are not mounted until requested');
  const requests = await read('calls.length+calendarCalls.length');
  win.webContents.sendInputEvent({type:'mouseMove',x:900,y:600});
  await move('.builtin-calendar [aria-current=date]');
  await until(visible);
  await until('document.querySelectorAll(".calendar-day-job").length===16');
  assert.equal(await read('document.querySelectorAll(".calendar-day-note").length'), 2, 'widget shares holiday and spanning-date data');
  assert.equal(await read('!!document.querySelector(".calendar-lunar-date")'), true);
  assert.equal(await read('calls.length+calendarCalls.length'), requests, 'hover only uses existing snapshots');
  assert.equal(await checkBounds(), true, 'top-layer details fit viewport outside clipped component');
  await move('.calendar-day-details header'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await read(visible), true, 'pointer can cross into the details without flickering');
  await capture('calendar-widget-hover.png');
  win.webContents.sendInputEvent({type:'mouseMove',x:1050,y:800}); await until('!document.querySelector(".calendar-day-details")');
  await read('document.querySelector(".builtin-calendar [aria-current=date]").click()'); await until(visible);
  await read('state.jobs.find(j=>j.id==="calendar-0").name="更新后的任务";notify();');
  await until('document.querySelector(".calendar-day-details").textContent.includes("更新后的任务")');
  await read('calendarState.datasets.find(item=>item.calendar.id==="hover-test").enabled=false;for(const listener of calendarListeners)listener();');
  await until('document.querySelectorAll(".calendar-day-note").length===0');
  await read('document.querySelector(".calendar-day-details").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));void 0');
  await until('!document.querySelector(".calendar-day-details")');
  assert.equal(await read('document.activeElement.getAttribute("aria-current")'), 'date', 'Escape returns focus to date without reopening');
  await read('renderCalendarWidgets("en",1)'); await until('document.querySelectorAll(".builtin-calendar").length===1');
  win.setSize(420,820); await until('innerWidth<450');
  await read('document.querySelector(".widget-fixture").style.zoom="1.25";void 0');
  await move('.builtin-calendar [aria-current=date]'); await until(visible);
  assert.equal(await checkBounds(), true, '125% widget hover remains within a narrow viewport');
  assert.ok(await read('document.querySelector(".calendar-day-details").textContent.includes("Automations")'));
  await capture('calendar-widget-hover-narrow.png');
  assert.equal(await read('calls.filter(c=>c.action!=="list").length'), await read('hoverMutations'), 'hover, focus and navigation never run or edit tasks');
  console.log('Calendar widget passed: actual hover, holidays/lunar/spanning dates, live schedules, shared subscription, no hover requests or mutations, popup handoff, Escape, clipping and 125% narrow viewport.');
};
