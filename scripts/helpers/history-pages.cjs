const assert = require('node:assert/strict');
module.exports = async ({ run, until, pause }) => {
  await run(`
    window.pageReads = [];
    window.readHistoryPage = (id, options) => new Promise((resolve, reject) => pageReads.push({id,options,resolve,reject}));
    window.makeHistoryResult = (first, last, revision = 0) => ({conversation:{id:'a',title:'A'},toolExecutions:[],
      messages:Array.from({length:last-first+1},(_,i)=>({id:'m'+(first+i),role:'user',content:'message '+(first+i),turnSequence:first+i})),
      historyPage:{firstTurnSequence:first,totalTurns:40,historyRevision:revision,nextCursor:first>1?{beforeTurnSequence:first,historyRevision:revision}:null}});
    function HistoryFixture() {
      const [messages,setMessages] = React.useState({}); const [active,setActive] = React.useState('a');
      const pages = views.useConversationHistoryPages({read:readHistoryPage,activeId:active,messages,setMessages,
        refresh:async id=>{const result=await pageFixture.pages.read(id);setMessages(value=>({...value,[id]:result.messages}));}});
      window.pageFixture={messages,pages,setMessages,setActive};
      return h('div',null,'history fixture');
    }
    renderView(h(React.StrictMode,null,h(HistoryFixture)));
  `);
  await until('!!window.pageFixture', 'history hook mounted');
  await run(`void pageFixture.pages.read('a').then(result => pageFixture.setMessages(value=>({...value,a:result.messages})))`);
  await until('pageReads.length===1', 'tail requested');
  assert.deepEqual(await run('pageReads[0].options.page'), {}, 'shared read opts into paging');
  await run('pageReads[0].resolve(makeHistoryResult(21,40))');
  await until('pageFixture.messages.a?.length===20 && pageFixture.pages.hasMore', 'first page published with cursor');
  await run('void pageFixture.pages.loadOlder(); void pageFixture.pages.loadOlder()');
  await until('pageReads.length===2', 'older requested once');
  assert.equal(await run('pageReads[1].options.page.cursor.beforeTurnSequence'), 21);
  await run(`pageFixture.setMessages(value=>({...value,a:[...value.a,{id:'live',role:'assistant',content:'live output'}]}));`);
  await pause(20);
  await run('pageReads[1].resolve(makeHistoryResult(1,20))');
  await until('pageFixture.messages.a?.length===41', 'older messages join live tail');
  assert.equal(await run('pageFixture.messages.a.at(-1).id'), 'live');
  assert.equal(await run('pageFixture.pages.hasMore'), false);
  await run(`void pageFixture.pages.read('a').then(result=>pageFixture.setMessages(value=>({...value,a:result.messages})));`);
  await until('pageReads.length===3', 'tail refreshed');
  await run('pageReads[2].resolve(makeHistoryResult(21,40))');
  await until('pageFixture.messages.a.length===40', 'refresh preserves previously loaded history');
  assert.equal(await run('pageFixture.messages.a[0].id'), 'm1');
  await run(`void pageFixture.pages.read('a').then(result=>pageFixture.setMessages(value=>({...value,a:result.messages})));`);
  await until('pageReads.length===4', 'new history branch requested');
  await run('pageReads[3].resolve(makeHistoryResult(21,40,7))');
  await until('pageFixture.messages.a.length===20 && pageFixture.pages.hasMore', 'new branch resets old window');
  await run('void pageFixture.pages.loadOlder()');
  await until('pageReads.length===5', 'older pending before eviction');
  await run('pageFixture.setMessages({b:[]});pageFixture.setActive("b")');
  await until('pageReads[4].options.signal.aborted', 'evicted read cancelled');
  await run('pageReads[4].resolve(makeHistoryResult(1,20,7))');
  await pause(50);
  assert.equal(await run('pageFixture.messages.a===undefined'), true, 'late history cannot resurrect an evicted session');
  await run(`pageFixture.setActive('a');void pageFixture.pages.read('a').then(result=>pageFixture.setMessages(value=>({...value,a:result.messages})));`);
  await until('pageReads.length===6','read new branch after eviction');
  await run('pageReads[5].resolve(makeHistoryResult(21,40,8))');
  await until('pageFixture.pages.hasMore','new branch is ready');
  await run('void pageFixture.pages.loadOlder()'); await until('pageReads.length===7','stale cursor request');
  await run('pageReads[6].reject(Error("Session history changed. Refresh the conversation."))');
  await until('pageFixture.pages.needsRefresh','supersession requires a refresh');
  await run('void pageFixture.pages.loadOlder()'); await until('pageReads.length===8','refresh uses ordinary reader');
  assert.equal(await run('pageReads[7].options.page.cursor===undefined'),true);
  await run('pageReads[7].resolve(makeHistoryResult(21,40,9))');
  await until('!pageFixture.pages.needsRefresh && !pageFixture.pages.loadingOlder','fresh branch replaces stale cursor');
  await run('updateChat({historyPages:undefined})');
  console.log('History paging passed: initial cursor, deduplication, live tail, refresh, branch invalidation and eviction fences.');
};
