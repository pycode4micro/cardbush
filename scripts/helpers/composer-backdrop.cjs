const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function check(run) {
  const geometry = await run(`(()=>{
    const dock=document.querySelector('.composer-dock'),list=document.querySelector('.message-list');
    const d=dock.getBoundingClientRect(),s=list.getBoundingClientRect(),before=getComputedStyle(dock,'::before');
    const scale=s.width/list.offsetWidth;
    return {left:d.left+parseFloat(before.left)*scale,right:d.right-parseFloat(before.right)*scale,
      listLeft:s.left,contentRight:s.left+list.clientWidth*scale,
      inset:list.offsetWidth-list.clientWidth,scrollable:list.scrollHeight>list.clientHeight,
      managed:!!dock.closest('.composer-layout-managed')};
  })()`);
  assert.ok(geometry.scrollable && geometry.inset > 0, 'fixture has a native scrollbar: ' + JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.left-geometry.listLeft)<1 && Math.abs(geometry.right-geometry.contentRight)<1,
    'backdrop covers the transcript gutters but never the scrollbar: ' + JSON.stringify(geometry));
}

module.exports = async ({run,until,pause,window,root}) => {
  await run(`window.backdropSaved={...chatProps};updateChat({activeConversationId:'backdrop-test',loading:false,
    sending:false,activeTurnId:'',windowMaximized:false,messages:[{id:'backdrop-answer',role:'assistant',
    content:'Scrollable reply. '.repeat(1800),status:'completed',metadata:{transcript_kind:'assistant_final'}}]});`);
  await until('!!document.querySelector(".assistant-final-answer")','backdrop transcript');
  try {
    for (const theme of ['dark','light']) for (const embedded of [false,true]) {
      await run(`document.querySelector('.app').classList.remove('theme-dark','theme-light');
        document.querySelector('.app').classList.add('theme-${theme}');updateChat({embedded:${embedded}});`);
      await pause(300);
      await check(run);
      fs.writeFileSync(path.join(root,'tmp',`composer-backdrop-${theme}-${embedded?'child':'main'}.png`),(await window.webContents.capturePage()).toPNG());
    }
    console.log('Composer backdrop passed: main/embedded panes and both themes leave native scrollbars clear.');
  } finally { await run('updateChat(backdropSaved)'); }
};
module.exports.check=check;
