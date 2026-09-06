// Opt-in real desktop tests. Every input targets an isolated test window.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';

if(process.platform!=='win32')throw new Error('Windows required');
const fixture=launchDesktopFixture();
const config=defaultAppsRuntimeConfig().computerUse.config;
const checks=[];let hwnd;let sequence=0;
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const textError=error=>[error.message||String(error),error.stderr].filter(Boolean).join('\n');
const act=(scope,input,signal)=>executeComputerUse(input,config,signal,scope);
const observe=scope=>act(scope,{action:'observe',hwnd});
const element=(observed,id)=>{const found=observed.output.accessibility.elements.find(e=>e.automation_id===id);assert.ok(found,`Missing ${id}`);return found;};
const bound=(observed,input)=>({...input,hwnd,state_id:observed.output.state_id});
const reject=async(promise,pattern)=>assert.rejects(promise,error=>{assert.match(textError(error),pattern);return true;});
async function appState(predicate,label){let actual;for(let attempt=0;attempt<40;attempt++){actual=await fixture.command('inspect');if(predicate(actual))return actual;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(`${label}: ${JSON.stringify(actual)}`);}
async function check(name,body){const scope=`adversarial-${++sequence}`;if(process.env.CARDBUSH_TEST_FILTER&&!name.includes(process.env.CARDBUSH_TEST_FILTER))return;try{await body(scope);checks.push({name,passed:true});console.log('PASS',name);}finally{await act(scope,{action:'finish'}).catch(()=>undefined);}}
try{
  const ready=await fixture.ready;hwnd=ready.hwnd;
  await check('failed target capture never returns pixels from an overlapping window',async()=>{
    await fixture.command('overlap');
    const source=await readFile(new URL('../src/plugins/computerUseRuntime.ts',import.meta.url),'utf8');
    const script=source.match(/const windowStateCaptureScript = String.raw`([\s\S]*?)`;/)?.[1];
    assert.ok(script,'native capture script found');
    const fault=script.replace('[CardBushWindowCapture]::PrintWindow($h, $hdc, 2)','$false');
    assert.notEqual(fault,script,'inject PrintWindow failure');
    const directory=await mkdtemp(join(tmpdir(),'cardbush-capture-fault-'));const path=join(directory,'must-not-exist.png');
    await reject(promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from('$ErrorActionPreference="Stop"\n'+fault,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,env:{...process.env,CARDBUSH_WINDOW_HWND:String(hwnd),CARDBUSH_CAPTURE_PATH:path}}),/capture failed/);
    await assert.rejects(readFile(path),{code:'ENOENT'});
    await fixture.command('uncover');
  });
  await check('discovery includes multiple windows from the same application',async scope=>{
    const background=await fixture.command('background');
    const discovered=await act(scope,{action:'observe'});
    assert.ok(discovered.output.windows.some(window=>window.hwnd===hwnd));
    assert.ok(discovered.output.windows.some(window=>window.hwnd===background.cover),'secondary window is discoverable');
    await fixture.command('uncover');
  });
  await check('disabled open and close policies prevent desktop mutations',async scope=>{
    const denied={...config,allowOpenApp:false,allowWindowClose:false};
    await reject(executeComputerUse({action:'open_app',app:'notepad.exe'},denied,undefined,scope),/Opening applications is disabled/);
    const observed=await observe(scope);
    await reject(executeComputerUse(bound(observed,{action:'window',operation:'close'}),denied,undefined,scope),/Closing windows is disabled/);
    assert.equal((await fixture.command('inspect')).hwnd,hwnd);
  });
  await check('capture updates after real Unicode typing and Enter',async scope=>{
    const before=await observe(scope);element(before,'fixture-input');
    const text='中文😀 + ^ % { } " <script>fixture</script>';
    await act(scope,bound(before,{action:'type',text}));
    await appState(actual=>actual.text===text,'application independently received the complete Unicode text');
    const after=await observe(scope);assert.notEqual(await hash(before.paths[0]),await hash(after.paths[0]));
    assert.equal(element(after,'fixture-input').value,text);
    await act(scope,bound(after,{action:'key',key:'Enter'}));
    await appState(actual=>/\r?\n$/.test(actual.text),'Enter reaches application');
  });
  await check('UIA set_value changes the actual application',async scope=>{
    const observed=await observe(scope);const input=element(observed,'fixture-input');
    await act(scope,bound(observed,{action:'set_value',element_index:input.index,value:'UIA 中文'}));
    assert.equal((await fixture.command('inspect')).text,'UIA 中文');
  });
  await check('UIA button invoke and toggle happen exactly once',async scope=>{
    let observed=await observe(scope);const before=(await fixture.command('inspect')).count;
    await act(scope,bound(observed,{action:'invoke',element_index:element(observed,'fixture-button').index}));
    assert.equal((await fixture.command('inspect')).count,before+1);
    observed=await observe(scope);
    await act(scope,bound(observed,{action:'click',element_index:element(observed,'fixture-toggle').index}));
    assert.equal((await fixture.command('inspect')).toggled,true);
  });
  await check('read-only and password values are protected',async scope=>{
    let observed=await observe(scope);const password=element(observed,'fixture-password');
    assert.equal(password.password,true);assert.equal(password.value,undefined);
    await reject(act(scope,bound(observed,{action:'set_value',element_index:password.index,value:'must not overwrite'})),/password/);
    observed=await observe(scope);
    await reject(act(scope,bound(observed,{action:'set_value',element_index:element(observed,'fixture-readonly').index,value:'must not overwrite'})),/read-only/);
    const actual=await fixture.command('inspect');assert.equal(actual.readOnly,'READ ONLY');assert.equal(actual.passwordLength,'fixture-secret'.length);
  });
  await check('stale UIA value cannot overwrite newer application text',async scope=>{
    const observed=await observe(scope);await fixture.command('setText',{text:'newer content'});
    await reject(act(scope,bound(observed,{action:'set_value',element_index:element(observed,'fixture-input').index,value:'stale overwrite'})),/value changed/);
    assert.equal((await fixture.command('inspect')).text,'newer content');
  });
  await check('disabled or renamed UIA controls reject stale invocations',async scope=>{
    let observed=await observe(scope);const before=(await fixture.command('inspect')).count;
    await fixture.command('disableButton');
    await reject(act(scope,bound(observed,{action:'invoke',element_index:element(observed,'fixture-button').index})),/disabled/);
    await fixture.command('enableButton');observed=await observe(scope);
    await fixture.command('renameButton');
    await reject(act(scope,bound(observed,{action:'invoke',element_index:element(observed,'fixture-button').index})),/identity changed/);
    assert.equal((await fixture.command('inspect')).count,before);
    await fixture.command('resetButton');
  });
  await check('forged, cross-window and consumed state IDs cannot act',async scope=>{
    let observed=await observe(scope);
    await reject(act(scope,{action:'type',text:'bad',hwnd,state_id:'forged'}),/stale|another observation/);
    observed=await observe(scope);
    await reject(act(scope,{action:'type',text:'bad',hwnd:hwnd+1,state_id:observed.output.state_id}),/targets hwnd/);
    observed=await observe(scope);
    await act(scope,bound(observed,{action:'set_value',element_index:element(observed,'fixture-input').index,value:'once'}));
    await reject(act(scope,bound(observed,{action:'type',text:'twice'})),/fresh target-specific/);
    assert.equal((await fixture.command('inspect')).text,'once');
  });
  await check('moved window invalidates coordinate input',async scope=>{
    const observed=await observe(scope);await fixture.command('move');
    await reject(act(scope,bound(observed,{action:'click',x:100,y:100})),/bounds changed/);
  });
  await check('out-of-window input does not move the pointer',async scope=>{
    const observed=await observe(scope);const before=await fixture.command('inspect');
    await reject(act(scope,bound(observed,{action:'click',x:-1,y:20})),/outside the observed window/);
    const after=await fixture.command('inspect');assert.deepEqual([after.x,after.y],[before.x,before.y]);
  });
  await check('background input is rejected and exact activation recovers',async scope=>{
    await fixture.command('background');let observed=await observe(scope);
    assert.equal(observed.output.actionable,false);
    await reject(act(scope,bound(observed,{action:'type',text:'wrong target'})),/not foreground/);
    observed=await observe(scope);await act(scope,bound(observed,{action:'window',operation:'activate'}));
    observed=await observe(scope);assert.equal(observed.output.is_foreground,true);
  });
  await check('coordinates covered by another window cannot be clicked',async scope=>{
    await fixture.command('overlap');const observed=await observe(scope);
    await reject(act(scope,bound(observed,{action:'click',x:100,y:150})),/Target window changed|not foreground/);
    await fixture.command('uncover');
  });
  await check('coordinate click restores pointer and triggers one button event',async scope=>{
    const observed=await observe(scope);const button=element(observed,'fixture-button');const before=await fixture.command('inspect');
    await act(scope,bound(observed,{action:'click',x:Math.round(button.bounds.x+button.bounds.width/2),y:Math.round(button.bounds.y+button.bounds.height/2)}));
    const after=await fixture.command('inspect');assert.equal(after.count,before.count+1);assert.deepEqual([after.x,after.y],[before.x,before.y]);
  });
  await check('drag and scroll produce observable application changes',async scope=>{
    let observed=await observe(scope);const drag=observed.output.accessibility.elements.find(e=>e.name==='Drag only inside this fixture');assert.ok(drag,'drag surface label is observable');
    await act(scope,bound(observed,{action:'drag',x:drag.bounds.x+20,y:drag.bounds.y+20,to_x:drag.bounds.x+200,to_y:drag.bounds.y+20,duration_ms:400,steps:20}));
    assert.ok((await fixture.command('inspect')).dragMoves>0);
    observed=await observe(scope);const scroll=element(observed,'fixture-scroll');
    await act(scope,bound(observed,{action:'scroll',x:scroll.bounds.x+100,y:scroll.bounds.y+70,delta:-3}));
    const actual=await fixture.command('inspect');assert.ok(actual.wheels>0&&actual.scroll>0);
  });
  await check('cancellation before and during input preparation sends no text',async scope=>{
    let observed=await observe(scope);const before=(await fixture.command('inspect')).text;
    const aborted=new AbortController();aborted.abort(new DOMException('test stop','AbortError'));
    await reject(act(scope,bound(observed,{action:'type',text:'never'}),aborted.signal),/test stop/);
    const running=new AbortController();const pending=act(scope,bound(observed,{action:'type',text:'never'}),running.signal);
    setTimeout(()=>running.abort(new DOMException('test stop','AbortError')),100);
    await reject(pending,/abort|test stop/i);assert.equal((await fixture.command('inspect')).text,before);
  });
  await check('desktop ownership rejects a second concurrent scope',async scope=>{
    const pending=observe(scope);
    await reject(observe('competing-scope'),/already using the desktop|owns the window/);
    await pending;
  });
  await check('window resize and move are verified by fresh observation',async scope=>{
    let observed=await observe(scope);const previous=observed.output.bounds;
    await act(scope,bound(observed,{action:'window',operation:'resize',width:previous.width+20,height:previous.height}));
    observed=await observe(scope);assert.equal(observed.output.bounds.width,previous.width+20);
    await act(scope,bound(observed,{action:'window',operation:'move',x:previous.x+20,y:previous.y}));
    observed=await observe(scope);assert.equal(observed.output.bounds.x,previous.x+20);
  });
  await check('window minimize maximize and restore complete without false takeover',async scope=>{
    let observed=await observe(scope);
    await act(scope,bound(observed,{action:'window',operation:'maximize'}));
    await appState(actual=>actual.windowState==='Maximized','window maximized');
    observed=await observe(scope);
    await act(scope,bound(observed,{action:'window',operation:'restore'}));
    await appState(actual=>actual.windowState==='Normal','window restored');
    observed=await observe(scope);
    await act(scope,bound(observed,{action:'window',operation:'minimize'}));
    await appState(actual=>actual.windowState==='Minimized','window minimized');
    observed=await observe(scope);
    await act(scope,bound(observed,{action:'window',operation:'restore'}));
    await appState(actual=>actual.windowState==='Normal','minimized window restored');
    await fixture.command('activate');
  });
  await check('same-scope concurrency does not cancel the owning action',async scope=>{
    const observed=await observe(scope);const original=computerUsePresentation.action;
    let ready;const entered=new Promise(resolve=>ready=resolve);
    computerUsePresentation.action=async function(...args){const result=await original.apply(this,args);ready();return result;};
    try{
      const pending=act(scope,bound(observed,{action:'type',text:'owning operation'}));
      await entered;
      await reject(observe(scope),/already using the desktop/);
      await pending;
    }finally{computerUsePresentation.action=original;}
  });
  await check('foreground changes during typing never leak text into another window',async scope=>{
    const switchAfter=Number(process.env.CARDBUSH_SWITCH_AFTER||20);
    await fixture.command('switchDuringTyping',{after:switchAfter});const observed=await observe(scope);
    const pending=act(scope,bound(observed,{action:'type',text:'TARGET_ONLY_'.repeat(Math.max(100,Math.ceil((switchAfter+100)/12)))}));
    let rejected;try{await pending;}catch(error){rejected=error;}
    await new Promise(resolve=>setTimeout(resolve,300));
    const actual=await fixture.command('inspect');
    assert.equal(actual.text.length,switchAfter,'input reaches the scheduled foreground switch');
    console.log(JSON.stringify({foregroundSwitch:{targetCharacters:actual.text.length,foreignCharacters:actual.coverText.length-'COVER MUST NOT RECEIVE INPUT'.length,rejected:Boolean(rejected)}}));
    assert.equal(actual.coverText,'COVER MUST NOT RECEIVE INPUT');
    assert.ok(rejected,'foreground switch must abort input');
    await fixture.command('uncover');
  });
} catch(error){checks.push({passed:false,error:textError(error)});console.error(textError(error));process.exitCode=1;}
finally{
  computerUsePresentation.dispose();fixture.close();
  const directory=await mkdtemp(join(tmpdir(),'cardbush-computer-use-adversarial-'));
  const report=join(directory,'report.json');await writeFile(report,JSON.stringify({createdAt:new Date().toISOString(),checks},null,2));
  console.log(JSON.stringify({passed:!process.exitCode,checks:checks.length,report}));
}
