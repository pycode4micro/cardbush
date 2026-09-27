// Opt-in real Windows smoke test, confined to a disposable fixture window.
// Run after building: node test/computerUsePresentation.native.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerUsePresentationNative } from '../dist/plugins/computerUsePresentationNative.js';
import { ComputerUsePresentation, computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';
import sharp from 'sharp';
import { runComputerUsePowerShell } from '../dist/plugins/computerUsePowerShell.js';
import { computerUseCaptureLayersScript } from '../dist/plugins/computerUseCaptureLayers.js';

if (process.platform !== 'win32') throw new Error('This smoke test requires Windows.');
const fixture = String.raw`
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Threading;
using System.Collections.Generic;
using System.Text;
public static class Fixture {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int capacity);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  static void Emit(object v) { Console.WriteLine(new JavaScriptSerializer().Serialize(v)); Console.Out.Flush(); }
  public static void Run() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    Application.EnableVisualStyles();
    Form f=new Form(); f.Text="CardBush Computer Use · isolated visual test";
    f.StartPosition=FormStartPosition.Manual; f.Bounds=new Rectangle(70,110,760,450);
    f.BackColor=Color.FromArgb(24,27,30);
    Form cover=new Form(); cover.Text="CardBush background-window test fixture";
    cover.StartPosition=FormStartPosition.Manual; cover.Bounds=new Rectangle(900,110,360,220);
    f.FormClosed+=(s,e)=>cover.Dispose();
    Label label=new Label(); label.Text="Computer Use presentation test\n\nWindow-scoped border / CardBush pointer / Stop";
    label.ForeColor=Color.FromArgb(213,222,224); label.Font=new Font("Segoe UI",15);
    label.Bounds=new Rectangle(50,95,630,140); f.Controls.Add(label);
    Button button=new Button(); button.Text="Increment 0"; button.Bounds=new Rectangle(50,280,140,36);
    int count=0; button.Click+=(s,e)=>{button.Text="Increment "+(++count);}; f.Controls.Add(button);
    f.Shown+=(s,e)=> { POINT p; GetCursorPos(out p); Emit(new {kind="ready", hwnd=f.Handle.ToInt64(), x=p.x,y=p.y}); };
    Thread reader=new Thread(()=> {
      string line;
      while((line=Console.ReadLine())!=null) {
        var v=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);
        f.BeginInvoke(new Action(()=> {
          string op=Convert.ToString(v["op"]);
          if(op=="quit") { f.Close(); return; }
          if(op=="move") f.Left+=60;
          if(op=="minimize") f.WindowState=FormWindowState.Minimized;
          if(op=="activate") { f.WindowState=FormWindowState.Normal; f.Activate(); }
          if(op=="background") { cover.Show(); cover.Activate(); }
          var children=new List<object>(); IntPtr stop=IntPtr.Zero; RECT stopRect=new RECT();
          EnumChildWindows(f.Handle,(h,p)=> { RECT r; GetWindowRect(h,out r); if(r.b-r.t==32){stop=h;stopRect=r;} var text=new StringBuilder(256);GetWindowText(h,text,text.Capacity);children.Add(new {hwnd=h.ToInt64(), text=text.ToString(), visible=IsWindowVisible(h),x=r.l,y=r.t,width=r.r-r.l,height=r.b-r.t}); return true; },IntPtr.Zero);
          if(op=="stop" && stop!=IntPtr.Zero) PostMessage(stop,0x202,new IntPtr(0),new IntPtr((16<<16)|(stopRect.r-stopRect.l-20)));
          if(op=="capture") {
            RECT r; GetWindowRect(f.Handle,out r);
            using(Bitmap b=new Bitmap(r.r-r.l,r.b-r.t)) using(Graphics g=Graphics.FromImage(b)) {
              IntPtr dc=g.GetHdc(); try {PrintWindow(f.Handle,dc,2);} finally {g.ReleaseHdc(dc);}
              b.Save(Convert.ToString(v["path"]),System.Drawing.Imaging.ImageFormat.Png);
            }
          }
          POINT cursor; GetCursorPos(out cursor); Emit(new {kind="ack",op=op,children=children,x=cursor.x,y=cursor.y,foreground=GetForegroundWindow().ToInt64(),count=count});
        }));
      }
      try { f.BeginInvoke(new Action(()=>f.Close())); } catch {}
    });
    f.Load+=(s,e)=> {reader.IsBackground=true;reader.Start();}; Application.Run(f);
  }
}`;

function launch(source, entry, name) {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CB_SOURCE))) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions; [${entry}]::Run()`;
  const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {
    windowsHide:true, stdio:'pipe', env:{...process.env,CB_SOURCE:Buffer.from(source).toString('base64')},
  });
  const notices=[]; const waiting=[]; let stderr='';
  child.stderr.on('data', b=>{stderr+=b;});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try {const value=JSON.parse(line); const waiter=waiting.shift(); if(waiter)waiter.resolve(value);else notices.push(value);}catch{}});
  child.on('exit',code=>{for(const w of waiting)w.reject(new Error(`${name} exited ${code}: ${stderr}`)); waiting.length=0;});
  return {child, send(v){child.stdin.write(JSON.stringify(v)+'\n');}, next(){
    if(notices.length)return Promise.resolve(notices.shift());
    return new Promise((resolve,reject)=>{
      const t=setTimeout(()=>reject(new Error(`${name} timed out: ${stderr}`)),15000);
      waiting.push({resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});
    });
  }};
}
const wait = ms=>new Promise(r=>setTimeout(r,ms));
const target=launch(fixture,'Fixture','fixture');
const overlay=launch(computerUsePresentationNative,'CardBushPresentation','overlay');
let bridge;
let id=0;
async function command(op,extra={}) {
  overlay.send({op,id:++id,scope:'native-test',...extra});
  let value=await overlay.next();
  while(value.kind!=='ack') value=await overlay.next();
  return value;
}
async function inspect(op='inspect',extra={}) {target.send({op,...extra});return target.next();}
try {
  const initial=await target.next(); assert.equal(initial.kind,'ready');
  assert.equal((await overlay.next()).kind,'ready');
  const hwnd=initial.hwnd;
  await inspect('activate'); await wait(300);
  assert.match((await command('observe',{hwnd:123})).error,/no longer exists/);
  assert.equal((await command('observe',{hwnd})).error,undefined);
  const normal=await inspect();
  const frame=normal.children.find(x=>x.width>700 && x.height>300);
  const badge=normal.children.find(x=>x.height===32);
  assert.ok(frame?.visible && badge?.visible,`frame and Stop are visible children of the fixture: ${JSON.stringify(normal)}`);
  const assertRetained=async(label,status)=>{
    const state=await inspect();
    assert.ok(state.children.find(x=>x.hwnd===frame.hwnd)?.visible,`${label}: same frame remains visible`);
    const actual=state.children.find(x=>x.hwnd===badge.hwnd);
    assert.ok(actual?.visible,`${label}: same badge remains visible`);
    if(status) assert.match(actual.text,status,label);
  };
  const foreign=await command('observe',{scope:'other-session',hwnd});
  assert.match(foreign.error,/Another session/);
  assert.equal((await command('action',{hwnd,action:'click',x:335,y:230})).error,undefined);
  await wait(120);
  const screenshot=join(tmpdir(),'cardbush-computer-use-presentation-smoke.png');
  await inspect('capture',{path:screenshot});
  const moved=await inspect('move'); await wait(100);
  const afterMove=await inspect();
  assert.equal(afterMove.children.find(x=>x.hwnd===frame.hwnd).x,frame.x+60);
  await command('suspend');
  const hidden=await inspect(); assert.ok(hidden.children.filter(x=>x.hwnd===frame.hwnd || x.hwnd===badge.hwnd).every(x=>!x.visible));
  await command('restore');
  await inspect('minimize'); await wait(100);
  const minimized=await inspect(); assert.ok(minimized.children.filter(x=>x.hwnd===frame.hwnd || x.hwnd===badge.hwnd).every(x=>!x.visible));
  await inspect('activate'); await wait(100);
  await command('pause');
  await assertRetained('user takeover',/已暂停/);
  const pausedAction=await command('action',{hwnd,action:'click',x:100,y:100});
  assert.match(pausedAction.error,/taken over/);
  await command('hold');
  await assertRetained('rejected input preserves pause',/已暂停/);
  await inspect('background'); await wait(100);
  await assertRetained('foreground loss retains attached surfaces',/已暂停/);
  await inspect('activate'); await wait(1250);
  assert.equal((await command('observe',{hwnd})).paused,false);
  await assertRetained('resume reuses the same surfaces',/待命/);
  await command('hold');
  await assertRetained('recoverable failure',/等待观察/);
  await command('observe',{hwnd});
  // Hold a real capture mask across finish. Its delayed restore must not bring
  // the ended session back. The fixture's IPC never sends user input.
  const mask=runComputerUsePowerShell(`${computerUseCaptureLayersScript}
$handles = [CardBushCaptureLayers]::Hide([IntPtr]${hwnd})
try { Start-Sleep -Milliseconds 1800 }
finally { [CardBushCaptureLayers]::Restore($handles) }
$handles.Length`,{env:{...process.env},timeoutMs:10000});
  const maskingDeadline=Date.now()+5000;
  let masked=false;
  while(Date.now()<maskingDeadline) {
    const state=await inspect();
    masked=[frame.hwnd,badge.hwnd].every(h=>state.children.some(x=>x.hwnd===h && !x.visible));
    if(masked) break;
    await wait(40);
  }
  assert.equal(masked,true,'capture hides both tagged surfaces');
  await command('finish');
  assert.equal(Number((await mask).trim()),2);
  const finishedCapture=await inspect();
  assert.ok([frame.hwnd,badge.hwnd].every(h=>finishedCapture.children.some(x=>x.hwnd===h && !x.visible)),'capture restore cannot resurrect a finished session');
  await command('observe',{hwnd});
  await assertRetained('new observation after finish',/待命/);
  await inspect('stop');
  const stopped=await overlay.next(); assert.equal(stopped.kind,'stopped'); assert.equal(stopped.reason,'button');
  await wait(250);
  const ended=await inspect(); assert.ok(ended.children.filter(x=>x.hwnd===frame.hwnd || x.hwnd===badge.hwnd).every(x=>!x.visible));
  assert.deepEqual({x:ended.x,y:ended.y},{x:initial.x,y:initial.y},'presentation never moves the system pointer');
  const closed=new Promise(resolve=>overlay.child.once('exit',resolve));
  overlay.child.stdin.end(); await closed;
  bridge=new ComputerUsePresentation();
  await bridge.observe('bridge-scope',hwnd);
  assert.throws(()=>bridge.assertAvailable('another-scope'),/Another Computer Use/);
  const action=await bridge.action('bridge-scope',{action:'click',x:200,y:250},{hwnd,elements:[]});
  await inspect('stop'); await wait(150);
  assert.equal(action.signal.aborted,true,'native stop cancels the plugin operation');
  assert.throws(()=>bridge.assertAvailable('bridge-scope'),/stopped/);
  await action.release(); await bridge.finish('bridge-scope');
  await assert.rejects(bridge.observe('bridge-scope',hwnd),/stopped/,'finish cannot erase user stop');
  await bridge.observe('next-user-turn',hwnd);
  await bridge.finish('next-user-turn'); await wait(200);
  bridge.dispose(); await wait(200);
  const config=defaultAppsRuntimeConfig().computerUse.config;
  const background=await inspect('background');
  assert.notEqual(background.foreground,hwnd,'only the second disposable fixture takes foreground');
  let observed=await executeComputerUse({action:'observe',hwnd,include_text:true},config,undefined,'runtime-smoke');
  const cleanCapture=observed.paths[0];
  const runtimeLayers=(await inspect()).children.filter(x=>x.height===32 || x.width>700 && x.height>300).map(x=>x.hwnd);
  assert.equal(runtimeLayers.length,2);
  const assertRuntimeRetained=async()=>{
    const state=await inspect();
    assert.ok(runtimeLayers.every(h=>state.children.some(x=>x.hwnd===h && x.visible)),'runtime retains visible surfaces after preflight rejection and observation');
  };
  assert.equal(observed.output.is_foreground,false);
  assert.equal(observed.output.actionable,false);
  assert.equal(observed.output.window_action_available,true);
  assert.match(observed.output.next_step,/window\/activate/);
  assert.notEqual((await inspect()).foreground,hwnd,'observation must not steal focus');
  for(const input of [{action:'type',text:'must not be sent'},{action:'click',x:20,y:20}]) {
    await assert.rejects(executeComputerUse({...input,hwnd,state_id:observed.output.state_id},config,undefined,'runtime-smoke'),/not foreground; no input was sent.*operation=activate/);
    await wait(250);
    await assertRuntimeRetained();
    observed=await executeComputerUse({action:'observe',hwnd,include_text:true},config,undefined,'runtime-smoke');
    await assertRuntimeRetained();
    assert.ok(observed.output.accessibility.elements.every(x=>!/^CardBush · |^CardBush 操作中/.test(x.name)),'our retained badge is excluded from application UIA evidence');
  }
  // Both shots have identical application content; only the second has an
  // attached presentation. Compare the client pixels containing its badge.
  const crop={left:450,top:45,width:275,height:40};
  const pixels=path=>sharp(path).extract(crop).removeAlpha().raw().toBuffer();
  assert.deepEqual(await pixels(observed.paths[0]),await pixels(cleanCapture),'capture excludes the retained badge');
  assert.equal((await inspect()).count,0,'rejected actions have not clicked the fixture');
  const activated=await executeComputerUse({action:'window',operation:'activate',hwnd,state_id:observed.output.state_id},config,undefined,'runtime-smoke');
  assert.equal(activated.output.operation,'focus');
  assert.equal((await inspect()).foreground,hwnd,'activation succeeds only when the target actually becomes foreground');
  const originalObserve=computerUsePresentation.observe;
  let reached,unblock;
  const pendingObservation=new Promise(resolve=>{reached=resolve;});
  const observationGate=new Promise(resolve=>{unblock=resolve;});
  computerUsePresentation.observe=async function(...args) {
    await originalObserve.apply(this,args);
    reached(); await observationGate;
  };
  const pending=executeComputerUse({action:'observe',hwnd,include_text:true},config,undefined,'runtime-smoke');
  try {
    await Promise.race([pendingObservation,pending.then(()=>assert.fail('observation bypassed the gate'))]);
    await assert.rejects(executeComputerUse({action:'observe'},config,undefined,'runtime-smoke'),/already using the desktop/,'observation retains the desktop lease until completion');
    await assertRuntimeRetained();
  } finally {
    unblock(); computerUsePresentation.observe=originalObserve;
    observed=await pending;
  }
  assert.equal(observed.output.is_foreground,true);
  assert.equal(observed.output.actionable,true);
  let button=observed.output.accessibility.elements.find(x=>x.name==='Increment 0');
  assert.ok(button,'the fixture button is observable');
  const semantic=button.patterns.some(p=>['Invoke','Toggle','SelectionItem','ExpandCollapse'].includes(p));
  if(!semantic) {
    await assert.rejects(executeComputerUse({action:'click',hwnd,state_id:observed.output.state_id,element_index:button.index},config,undefined,'runtime-smoke'),error=>{
      assert.equal(error.info?.code,'invalid_action');
      assert.equal(error.info?.execution,'not_dispatched');
      assert.match(error.message,/does not support click/);
      return true;
    },'unsupported UIA actions fail instead of reporting success');
    observed=await executeComputerUse({action:'observe',hwnd,include_text:true},config,undefined,'runtime-smoke');
    button=observed.output.accessibility.elements.find(x=>x.name==='Increment 0');
  }
  const selector=semantic ? {element_index:button.index} : {x:Math.round(button.bounds.x+button.bounds.width/2),y:Math.round(button.bounds.y+button.bounds.height/2)};
  const clicked=await executeComputerUse({action:'click',hwnd,state_id:observed.output.state_id,...selector},config,undefined,'runtime-smoke');
  assert.equal(clicked.output.input_mode,semantic?'ui_automation':'send_input');
  const verified=await executeComputerUse({action:'observe',hwnd,include_text:true},config,undefined,'runtime-smoke');
  assert.ok(verified.output.accessibility.elements.some(x=>x.name==='Increment 1'),`the real action completed exactly once: ${JSON.stringify({clicked:clicked.output,elements:verified.output.accessibility.elements})}`);
  await executeComputerUse({action:'finish'},config,undefined,'runtime-smoke');
  console.log(JSON.stringify({passed:true,screenshot,inputMode:clicked.output.input_mode,checks:['native child window clipping','single owner','window move','screenshot hide','minimize','pause blocks action with stable surfaces','foreground loss retains surfaces','resume reuses surfaces','recoverable errors retain surfaces','capture restoration respects finish','stop button','pointer unchanged','stop aborts running operation','stopped turn cannot restart','explicit finish cleanup','background observation does not steal focus','two preflight failures allow activation recovery','capture excludes the badge','UIA excludes the badge','observation retains desktop lease','activation verifies actual foreground','real Runtime observe/click/verify/finish','unsupported UIA cannot report success']}));
} catch (error) {
  console.error(String(error.stderr || error.stack || error).slice(-5000));
  process.exitCode=1;
} finally {
  bridge?.dispose();
  computerUsePresentation.dispose();
  target.child.stdin.end(); overlay.child.stdin.end();
  // EOF is the plugin lifecycle shutdown contract; bound cleanup if a native call hangs.
  const kill=setTimeout(()=>{target.child.kill();overlay.child.kill();},3000); kill.unref();
}
