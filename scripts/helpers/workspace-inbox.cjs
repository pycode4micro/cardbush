const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.seed = (root, sessionId) => {
  const at = new Date().toISOString(), folder = path.join(root, 'runtime-state', 'scheduler');
  fs.mkdirSync(folder, { recursive: true });
  const context = {title:'Inbox source',model:'fixture',prefixMessages:[],tools:[],permissionMode:'task_free',metadata:{},requestCapabilities:{interactiveRequests:true,vision:false}};
  fs.writeFileSync(path.join(folder, 'automations.json'), JSON.stringify({ version: 1, contexts: { [sessionId]: context }, jobs: [{
    id: 'event-job', sessionId, name: 'Inbox event', prompt: 'Check', executionMode: 'isolated', trigger: {kind:'once', at},
    timeZone:'UTC', revision:1, state:'completed', createdAt:at, lastEventIds:[], runs:[{
      id:'event-run', turnId:'event-turn', sessionId:'local-hidden', queuedAt:at, finishedAt:at, status:'completed',
      reason:'schedule', summary:'Time to check', result:'Time to check',
    }, {
      id:'earlier-result', turnId:'earlier-turn', sessionId:'local-hidden-earlier', queuedAt:'2024-01-01T09:00:00Z',
      finishedAt:'2024-01-01T09:01:00Z', status:'completed', reason:'schedule', summary:'Earlier reminder', result:'Earlier reminder',
    }],
  }] }));
};

exports.verify = async ({ win, read, visible, wait, click, sessionId }) => {
  const list = '.recent-bar-list', unread = list + '[data-unread]', inbox = '[data-recent-tab=notifications][aria-selected=true]';
  await visible(unread);
  // Restore one real session hint and an older client's mirrored hint for the same isolated run.
  const hint = (id, turnId) => ({sessionId:id,turnId,kind:'completed',title:id,body:'Background result',updatedAt:new Date().toISOString()});
  const stored = { 'local-earlier':hint('local-earlier','other-turn'), [sessionId]:hint(sessionId,'event-turn') };
  await read('localStorage.setItem("cardbush_session_attention_v1",' + JSON.stringify(JSON.stringify(stored)) + ')');
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  await visible(unread); await click(list); await visible(inbox);
  await wait(() => read("document.querySelectorAll('.recent-notification').length===3 && document.querySelector('.recent-notifications')?.innerText.includes('Inbox event')"), 'events and completion counted once')
    .catch(async error => { throw new Error(error.message + ': ' + await read("JSON.stringify([document.querySelector('.recent-turn-drawer')?.innerText,localStorage.getItem('cardbush_session_attention_v1')])")); });
  await read("[...document.querySelectorAll('.recent-notification-open')].find(el => el.innerText.includes('local-earlier')).click()");
  await visible('.chat-panel .message-list [data-message-id="other-user"]');
  await click(list); await visible(inbox);
  assert.equal(await read("document.querySelectorAll('.recent-notification').length"), 2, 'viewing a completed chat keeps both events unread');
  await read("[...document.querySelectorAll('.recent-notification-open')].find(el => el.innerText.includes('Earlier reminder')).click()");
  await visible('.chat-panel .conversation-event-inbox details[open] [data-event-result="earlier-result"]');
  await wait(() => read("document.activeElement?.dataset.eventResult==='earlier-result'"), 'notification focuses the specific older card');
  assert.equal(await read("document.querySelector('#right-inspector')?.checkVisibility() ?? false"), false, 'notification leaves the conversation unsplit');
  const aligned = () => read(`(() => {const card=document.querySelector('.message-list .conversation-event-inbox');
    const body=card?.closest('.message-list-content')?.querySelector('.message-row');
    if (!body) return false; const a=card.getBoundingClientRect(), b=body.getBoundingClientRect();
    return a.width>0 && Math.abs(a.left-b.left)<=1 && Math.abs(a.right-b.right)<=1;})()`);
  await wait(aligned, 'wide event card aligned with transcript');
  win.setContentSize(820, 760);
  await wait(aligned, 'narrow event card aligned with transcript');
  await click(list); await visible(inbox); await click('.recent-notifications .event-result-ack');
  await wait(() => read("document.querySelectorAll('.recent-notifications .event-result-ack').length===1"), 'only the requested event is acknowledged');
  await click('.recent-notifications .event-result-ack');
  await visible('.recent-notifications-empty');
  assert.equal(await read("!!document.querySelector('.recent-bar-list[data-unread],.conversation-event-inbox')"), false, 'acknowledging in the list clears the badge and source card');
  await read("document.querySelector('[data-recent-tab=notifications]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowRight'}));");
  await visible('[data-recent-tab=pinned][aria-selected=true]');
  console.log('Desktop notifications passed: source navigation, scheduler receipts, session completion, legacy deduplication, keyboard and reading-track geometry.');
};
