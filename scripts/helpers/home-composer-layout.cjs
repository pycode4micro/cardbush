const assert = require('node:assert/strict');
module.exports = async ({run, until, window}) => {
  for (const width of [1080, 580]) {
    window.setContentSize(width, 740);
    await run("updateChat({language:'en', loading:false, historyLoading:false, messages:[],activeConversationId:'',draft:''})");
    await until("!!document.querySelector('.new-chat-input textarea')", 'empty chat input');
    await until(`(() => {const r = document.querySelector('.composer-surface').getBoundingClientRect(), b=document.querySelector('.chat-content-frame').getBoundingClientRect();return Math.abs(r.top+r.bottom-b.top-b.bottom)<4 && Math.abs(r.left+r.right-b.left-b.right)<4})()`, 'composer centered in the chat pane');
    assert.equal(await run("document.querySelectorAll('.welcome-composer iframe,.welcome-composer canvas,.welcome-composer .workspace-location-control').length"),0);
    await run("document.querySelector('.composer-tools button').click()");
    await until("!!document.querySelector('[aria-label=\"Simple input\"]')",'plus opens mode setting');
    const before = await run("document.querySelector('.composer-stack').classList.contains('simple')");
    await run("document.querySelector('[aria-label=\"Simple input\"]').click()");
    await until(`document.querySelector('.composer-stack').classList.contains('simple') === ${!before}`, 'plus changes the composer mode');
    await until("document.querySelector('[aria-label=\"Simple input\"]').getAttribute('aria-checked') === String(document.querySelector('.composer-stack').classList.contains('simple'))",'style updates in place');
    await run("document.querySelector('.composer-tools button').click()");
  }
};
