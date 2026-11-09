const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Automation UI timed out'); app.exit(1); }, 55000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const read = script => win.webContents.executeJavaScript(script).catch(error => { throw Error(`${error.message}\nScript: ${script}`); });
  const until = async script => { const end = Date.now() + 5000; while (!await read(script)) { if (Date.now() > end) throw Error('Timed out: '+script+'; '+await read('document.body.innerText')); await new Promise(r=>setTimeout(r,25)); } };
  const capture = async name => { await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await new Promise(resolve=>setTimeout(resolve,180)); writeFileSync(resolve('tmp',name),(await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); };
  try {
    await win.loadFile(join(directory,'index.html'));
    win.setSize(1100,900);
    await read(`{
      const today=new Date(); window.fixtureDay=new Date(today.getFullYear(),today.getMonth(),today.getDate());
      window.fixtureKey=date=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
      window.fixtureAt=(offset,hour)=>new Date(fixtureDay.getFullYear(),fixtureDay.getMonth(),fixtureDay.getDate()+offset,hour).toISOString();
      const names=['整理今日项目构建结果','检查千川账户投放消耗','生成每日经营数据简报','检查长视频切片与字幕','同步插件版本和依赖','检查未完成任务的最新状态与问题','整理素材和商品图片','生成周报与销售趋势图','检查桌面文件导出结果','汇总本周用户反馈','更新经营看板的数据','检查任务与缓存状态','整理参考视频素材','准备明天的内容发布'];
      state.jobs=names.map((name,index)=>({id:'calendar-'+index,revision:1,name,prompt:'请按照当前工作区的真实数据处理任务，保留原文件并返回完整结果。隐藏关键词：逐项核对导出清单。',sessionId:'session',trigger:{kind:'once',at:fixtureAt(0,8+index)},nextRunAt:fixtureAt(0,8+index),timeZone:'Asia/Shanghai',state:'active',createdAt:fixtureAt(-1,0),runs:[]}));
      const base=state.jobs[0];
      state.jobs.push({...base,id:'tomorrow',name:'明天检查构建和导出文件',trigger:{kind:'once',at:fixtureAt(1,10)},nextRunAt:fixtureAt(1,10)});
      state.jobs.push({...base,id:'frequent',name:'每十五分钟检查构建状态',trigger:{kind:'interval',at:fixtureAt(0,8),seconds:900},nextRunAt:fixtureAt(0,8)});
      state.jobs.push({...base,id:'event-only',name:'工具失败时检查原因',trigger:{kind:'event',event:'PostToolUseFailure',tool:'terminal_exec',cooldownSeconds:60}});
      state.jobs.push({...base,id:'paused',name:'已暂停的计划',state:'paused'});
      state.jobs.push({...base,id:'history',name:'已完成的每日数据汇总',state:'completed',nextRunAt:undefined,runs:[{id:'calendar-result',turnId:'result-turn',queuedAt:fixtureAt(0,7),finishedAt:fixtureAt(0,8),status:'completed',reason:'schedule'}]});
      notify();
    }`);
    await require('./helpers/calendar-hover-ui.cjs')({ read, until, win, capture });
    console.log('Event calendar UI passed.');
  } finally { clearTimeout(deadline); win.destroy(); }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
