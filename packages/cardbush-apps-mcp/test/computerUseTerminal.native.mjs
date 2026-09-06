// A new, uniquely titled terminal only. Never reuse the user's existing tabs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';

if(process.platform!=='win32')throw new Error('Windows required');
const exec=promisify(execFile);
const directory=await mkdtemp(join(tmpdir(),'cardbush-terminal-fixture-'));
const title=`CardBush terminal test ${randomUUID()}`;
const resultPath=join(directory,'command-result.txt');
const busyInputPath=join(directory,'busy-input.txt');
const busyReadyPath=join(directory,'busy-ready.txt');
const unintendedPath=join(directory,'must-not-execute.txt');
const busyPath=join(directory,'busy.cjs');
const marker='CARDBUSH_VERIFIED_COMMAND_OUTPUT';
const config={...defaultAppsRuntimeConfig().computerUse.config,allowWindowClose:true};
const scope=`terminal-test-${randomUUID()}`;let hwnd;
const ps=value=>"'"+value.replaceAll("'","''")+"'";
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
async function waitFor(read,condition,label){let value;for(let i=0;i<60;i++){value=await read();if(condition(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Timed out: ${label}`);}
const call=input=>executeComputerUse(input,config,undefined,scope);
const observe=()=>call({action:'observe',hwnd});
const bound=(state,input)=>({...input,hwnd,state_id:state.output.state_id});
const report={title,directory,checks:[]};
try{
  await writeFile(busyPath,`const fs=require('fs'); if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdout.write('CARDBUSH_BUSY_RAW_INPUT_FIXTURE\\r\\n');fs.writeFileSync(${JSON.stringify(busyReadyPath)},'ready');process.stdin.resume();process.stdin.on('data',data=>{fs.appendFileSync(${JSON.stringify(busyInputPath)},data);if(data.includes(3))process.exit(0);});`);
  const startup=`function prompt { 'CARDBUSH_FIXTURE> ' }; Write-Output 'CARDBUSH_INTERACTIVE_FIXTURE_READY'`;
  // This is the explicitly visible interactive fixture, not a background worker.
  await exec('wt.exe',['-w','new','new-tab','--title',title,'--suppressApplicationTitle','powershell.exe','-NoLogo','-NoProfile','-NoExit','-EncodedCommand',Buffer.from(startup,'utf16le').toString('base64')],{windowsHide:false,timeout:15000});
  const target=await waitFor(async()=>{const windows=(await call({action:'observe'})).output.windows;return windows.find(w=>w.title===title);},Boolean,'new terminal appears');
  hwnd=target.hwnd;
  let state=await observe();
  if(!state.output.is_foreground){await call(bound(state,{action:'window',operation:'activate'}));state=await observe();}
  const initialImage=state.paths[0];
  const command=`[IO.File]::WriteAllText(${ps(resultPath)},${ps(marker)}); Write-Output ${ps(marker)}`;
  await call(bound(state,{action:'type',text:command}));state=await observe();
  await call(bound(state,{action:'key',key:'Enter'}));
  await waitFor(()=>readFile(resultPath,'utf8').catch(()=>''),value=>value===marker,'shell executes injected command');
  state=await observe();
  const executedImage=state.paths[0];
  assert.notEqual(await hash(initialImage),await hash(executedImage),'terminal capture changes with real command output');
  report.checks.push({name:'interactive terminal input executes verified command and updates capture',passed:true,before:initialImage,after:executedImage});
  console.log('PASS interactive terminal command and capture');

  await call(bound(state,{action:'type',text:`& ${ps(process.execPath)} ${ps(busyPath)}`}));state=await observe();
  await call(bound(state,{action:'key',key:'Enter'}));
  await waitFor(()=>readFile(busyReadyPath,'utf8').catch(()=>''),value=>value==='ready','child process owns terminal input');
  state=await observe();const busyImage=state.paths[0];
  const busyCommand=`[IO.File]::WriteAllText(${ps(unintendedPath)},'unexpected')`;
  await call(bound(state,{action:'type',text:busyCommand}));state=await observe();
  await call(bound(state,{action:'key',key:'Enter'}));
  await waitFor(()=>readFile(busyInputPath,'utf8').catch(()=>''),value=>value.includes(busyCommand),'busy process receives input');
  state=await observe();
  assert.equal(await readFile(resultPath,'utf8'),marker,'busy child did not execute a shell command');
  await assert.rejects(readFile(unintendedPath),{code:'ENOENT'});
  await assert.rejects(call(bound(state,{action:'key',key:'End'})),/without visible progress/);
  report.checks.push({name:'busy terminal accepts input without executing a shell command',passed:true,screenshotUnchanged:await hash(busyImage)===await hash(state.paths[0]),before:busyImage,after:state.paths[0]});
  console.log('PASS busy terminal dispatch is distinct from shell execution');
}catch(error){report.error=String(error.stderr||error.stack||error);process.exitCode=1;console.error(report.error.slice(-5000));}
finally{
  await call({action:'finish'}).catch(()=>undefined);
  // Only close the fixture HWND after verifying its unique title again.
  if(hwnd){const cleanupScope=`terminal-cleanup-${randomUUID()}`;try{const state=await executeComputerUse({action:'observe',hwnd},config,undefined,cleanupScope);if(state.output.window.title===title)await executeComputerUse(bound(state,{action:'window',operation:'close'}),config,undefined,cleanupScope);}catch(error){report.cleanupError=String(error.stderr||error.message||error);}finally{await executeComputerUse({action:'finish'},config,undefined,cleanupScope).catch(()=>undefined);}}
  computerUsePresentation.dispose();const file=join(directory,'report.json');await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:!process.exitCode,report:file}));
}
