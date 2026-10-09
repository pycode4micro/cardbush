const assert = require('node:assert/strict');

module.exports = async ({run,until,pause}) => {
  await run(`
    window.summaryOriginalCall=memoryCall;
    window.memoryCall=async(input,connection)=>{
      if(input.action==='status')await new Promise(resolve=>setTimeout(resolve,150));
      return summaryOriginalCall(input,connection);
    };
    memoryStats={...memoryStats,running:true,lastError:'memory_summary_output_limit: finish=length, input=1000, output=6144/6144, records=8.'};
    renderView(h('div',{className:'memory-settings',style:{height:'100%',overflow:'auto',padding:24}},h(MemoryPreferences)));
    document.querySelector('.summary-memory-actions .secondary-button').click();
  `);
  await until('document.querySelector(".summary-memory-actions .primary-button").textContent.includes("Summarizing")','observed background summary');
  await until('!!document.querySelector("[data-memory-id=habit_fixture]") && !document.querySelector("[data-memory-id=habit_fixture] button").disabled','records ready before polling');
  await run(`
    window.summaryCounter=document.querySelector('.summary-memory-status strong');
    window.summaryRecord=document.querySelector('[data-memory-id=habit_fixture]');
    window.summaryListReads=memoryListCalls;
    window.summaryPollStart=memoryCalls.filter(call=>call.input.action==='status').length;
    window.summaryDetached=false;
    window.summaryObserver=new MutationObserver(()=>{if(!summaryCounter.isConnected||!summaryRecord.isConnected)summaryDetached=true;});
    summaryObserver.observe(document.querySelector('.summary-settings'),{childList:true,subtree:true});
    memoryAction('Correct',summaryRecord).click();
  `);
  await until('!!document.querySelector(".memory-record-editor textarea")','editor stays usable during background consolidation');
  await pause(4400);
  await until('memoryCalls.filter(call=>call.input.action==="status").length>=summaryPollStart+2','two background status polls');
  await pause(200);
  assert.equal(await run('summaryDetached'),false,'status polls never remove the status or record nodes');
  assert.equal(await run('memoryListCalls'),await run('summaryListReads'),'status polling does not reload the record list');
  assert.equal(await run('!!document.querySelector(".memory-record-editor textarea")'),true,'polling does not discard the editor');
  assert.equal(await run('!!document.querySelector(".summary-memory-error")'),false,'a running job does not present an old failure as its current result');
  await run('memoryStats={...memoryStats,running:false,lastSummaryAt:Date.now(),lastError:null,estimatedTokens:900};');
  await pause(2200);
  await until('document.querySelector(".summary-memory-status strong").textContent.startsWith("900")','background completion updates in place');
  await until('memoryListCalls>summaryListReads','completed batch refreshes records');
  assert.equal(await run('summaryDetached'),false,'record refresh retains existing keyed rows');
  assert.equal(await run('!!document.querySelector(".memory-record-editor textarea")'),true,'completion preserves unsaved editing');
  await run('summaryObserver.disconnect();memoryAction("Cancel",document.querySelector(".memory-record-editor")).click();');

  // Manual requests also remain observable while the command is in flight.
  await run('holdMemorySummary=true;document.querySelector(".summary-memory-actions .primary-button").click();');
  await until('typeof finishMemorySummary==="function"','manual summary pending');
  await run('window.manualPollStart=memoryCalls.filter(call=>call.input.action==="status").length;memoryStats={...memoryStats,running:true,estimatedTokens:600};');
  await pause(2200);
  await until('memoryCalls.filter(call=>call.input.action==="status").length>manualPollStart','manual summary keeps polling');
  await until('document.querySelector(".summary-memory-status strong").textContent.startsWith("600")','partial progress appears before manual completion');
  await run('memoryStats={...memoryStats,running:false,estimatedTokens:300,lastSummaryAt:Date.now()};finishMemorySummary(memoryStats);holdMemorySummary=false;');
  await until('document.querySelector(".summary-memory-status strong").textContent.startsWith("300")&&!document.querySelector(".summary-memory-actions .primary-button").disabled','manual result retained');
  await run('memoryStats={...memoryStats,lastError:"memory_summary_timeout: finish=other, input=1000, output=20/6144, records=8."};document.querySelector(".summary-memory-actions .secondary-button").click();');
  await until('document.querySelector(".summary-memory-error summary")?.textContent.includes("timed out")','stored failure has a specific human-readable reason');
  await run('document.querySelector(".summary-memory-error summary").click();');
  assert.equal(await run('document.querySelector(".summary-memory-error pre").textContent.includes("records=8")'),true,'safe batch diagnostics remain available');
  await run('memoryStats={...memoryStats,lastError:null};document.querySelector(".summary-memory-actions .secondary-button").click();');
  await until('!document.querySelector(".summary-memory-error")','cleared failure is reflected');
  console.log('Memory summary stability passed: retained DOM, no repeated list loads, preserved editor, background completion and progressive manual status.');
};
