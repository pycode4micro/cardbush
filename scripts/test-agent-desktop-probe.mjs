import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAgentDesktop } from '../dist-electron/agentDesktopProbe.mjs';
import { sharedPluginCompatibility } from '../dist-electron/agentSharedPackages.mjs';

const ok = value => ({exitCode:0,stdout:JSON.stringify(value)});
test('Windows checks the actual interactive session and access, rather than rejecting the OS or service session number', async () => {
  for(const [interactive,inputDesktop,environment] of [[true,true,'ready'],[false,true,'blocked'],[true,false,'blocked']]){
    const calls=[];
    const result=await probeAgentDesktop({}, {platform:'win32',find:()=>'/powershell',run:async(...args)=>{calls.push(args);return ok({interactive,inputDesktop,sessionId:0,errorCode:inputDesktop?0:5});}});
    assert.equal(result.environment,environment); assert.equal(result.backend,'not_configured');
    assert.equal(result.state,'needs_setup'); assert.ok(result.remediation.length);
    assert.equal(calls.length,1); assert.ok(calls[0][1].includes('-EncodedCommand'));
    const script=Buffer.from(calls[0][1].at(-1),'base64').toString('utf16le');
    assert.match(script,/OpenInputDesktop/); assert.doesNotMatch(script,/SendInput|SetCursorPos|CreateProcessAsUser/);
  }
});
test('missing Windows probe dependency and execution failure remain repairable or unknown', async () => {
  const missing=await probeAgentDesktop({}, {platform:'win32',find:()=>undefined});
  assert.equal(missing.environment,'missing'); assert.equal(missing.state,'needs_setup');
  const failed=await probeAgentDesktop({}, {platform:'win32',find:()=>'/powershell',run:async()=>{throw Object.assign(Error('private-path-or-secret'),{code:'resource_protection_unavailable'});}});
  assert.equal(failed.state,'probe_failed'); assert.equal(failed.environment,'unknown');
  assert.doesNotMatch(JSON.stringify(failed),/private-path-or-secret/);
  assert.equal(failed.checks.at(-1).code,'resource_protection_unavailable');
});

test('Windows desktop probe finds the system binary when a service or scheduled task has no PowerShell on PATH',async()=>{
  const executable='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const result=await probeAgentDesktop({SystemRoot:'C:\\Windows',Path:'C:\\Windows\\System32'},{platform:'win32',
    find:name=>name===executable?name:undefined,run:async name=>{assert.equal(name,executable);return ok({interactive:true,inputDesktop:true,sessionId:1});}});
  assert.equal(result.environment,'ready');
});
test('Linux can use an existing display without Xvfb and does not activate a desktop during detection', async () => {
  const calls=[];
  const result=await probeAgentDesktop({DISPLAY:':7'},{platform:'linux',find:name=>name==='Xvfb'?undefined:`/bin/${name}`,run:async(exe,args)=>{
    calls.push({exe,args});
    return exe.endsWith('xdpyinfo') ? {exitCode:0,stdout:'display available'} : ok({modules:{mss:true,PIL:true,playwright:true},browser:true});
  }});
  assert.equal(result.environment,'ready');assert.equal(result.state,'not_enabled');assert.equal(result.backend,'available');
  assert.equal(result.checks.find(c=>c.id==='Xvfb').state,'missing');
  assert.equal(calls.length,2);assert.ok(!calls.some(c=>/Xvfb|xdotool|xclip/.test(c.exe)));
});
test('Linux missing display or dependencies reports setup steps and an invalid display is probed rather than trusted', async () => {
  const missing=await probeAgentDesktop({}, {platform:'linux',find:()=>undefined});
  assert.equal(missing.state,'needs_setup');assert.equal(missing.environment,'missing');assert.match(missing.remediation.join(' '),/Xvfb/);
  const blocked=await probeAgentDesktop({DISPLAY:':99'},{platform:'linux',find:name=>`/bin/${name}`,run:async exe=>
    exe.endsWith('xdpyinfo')?{exitCode:1,stdout:''}:ok({modules:{mss:true,PIL:true,playwright:true},browser:true})});
  assert.equal(blocked.environment,'blocked');assert.equal(blocked.checks.find(c=>c.id==='display_access').state,'blocked');
});
test('plugin compatibility uses concrete capability diagnostics and distinguishes a manifest platform limit from host feasibility', () => {
  const manifest={cardbush:{runtime:{platforms:['win32'],requires:['computerUse']}}};
  assert.equal(sharedPluginCompatibility(manifest,{},'win32',{},()=> 'detected session needs configuration'),undefined,
    'a missing built-in desktop backend does not disable a plugin-owned transport');
  assert.equal(sharedPluginCompatibility(manifest,{},'win32',{computerUse:true}),undefined);
  assert.match(sharedPluginCompatibility(manifest,{},'linux',{}),/plugin platform mismatch/);
  assert.doesNotMatch(sharedPluginCompatibility(manifest,{},'linux',{}),/unsupported Agent platform/);
});
