import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runComputerUsePowerShell, computerUsePowerShellParameters } from '../dist/plugins/computerUsePowerShell.js';
import { computerUsePresentationNative } from '../dist/plugins/computerUsePresentationNative.js';

const source = await readFile(new URL('../src/plugins/computerUseRuntime.ts', import.meta.url), 'utf8');
const windowsOnly = { skip: process.platform !== 'win32' };
const execute = async script => JSON.parse(await runComputerUsePowerShell(script, {
  cwd: process.cwd(), env: process.env, timeoutMs: 15000,
}));

test('native activation reports actual foreground independently of API return and preserves non-minimized window state', windowsOnly, async () => {
  const production = source.match(/const windowControlScript = String.raw`([\s\S]*?)`;/)[1];
  const stub = `Add-Type -TypeDefinition @'
using System;
public static class CardBushWindowControl {
  public struct RECT { public int Left,Top,Right,Bottom; }
  public static int Restores,Requests,Reads,Mode;
  public static bool ShowWindowAsync(IntPtr h,int c){Restores++;return true;}
  public static bool IsIconic(IntPtr h){return Mode==1;}
  public static bool SetForegroundWindow(IntPtr h){Requests++;return Mode!=1;}
  public static IntPtr GetForegroundWindow(){Reads++;return new IntPtr(Mode==0 || Requests==0 || Reads<4?222:101);}
  public static uint GetWindowThreadProcessId(IntPtr h,out uint pid){pid=h.ToInt64()==101?10u:20u;return 1;}
  public static bool GetWindowRect(IntPtr h,out RECT r){r=new RECT{Right=100,Bottom=100};return true;}
  public static void EnableDpiAwareness(){}
}
'@`;
  const body = production.replace(/Add-Type -TypeDefinition @'[\s\S]*?'@/, stub).replace('${computerUseDisplayGuardScript}', '');
  for (const mode of [0, 1, 2]) {
    const result = await execute(`${computerUsePowerShellParameters({ CARDBUSH_WINDOW_HWND: '101', CARDBUSH_WINDOW_OPERATION: 'focus',
      CARDBUSH_EXPECTED_WINDOW_PID: '10', CARDBUSH_EXPECTED_WINDOW_X: '0', CARDBUSH_EXPECTED_WINDOW_Y: '0',
      CARDBUSH_EXPECTED_WINDOW_WIDTH: '100', CARDBUSH_EXPECTED_WINDOW_HEIGHT: '100',
      CARDBUSH_FOREGROUND_GRANTED: mode ? '1' : '0', CARDBUSH_FOREGROUND_GRANT_ERROR: mode ? '0' : '5' })}
${body.replace('[CardBushWindowControl]::EnableDpiAwareness()', `[CardBushWindowControl]::Mode=${mode}`)}
[PSCustomObject]@{activation=$cardbushActivation;restores=[CardBushWindowControl]::Restores;requests=[CardBushWindowControl]::Requests} | ConvertTo-Json -Depth 5 -Compress`);
    assert.equal(result.requests, 1, 'no blind activation retry');
    assert.equal(result.restores, mode === 1 ? 1 : 0);
    assert.equal(result.activation.activated, mode !== 0);
    assert.equal(result.activation.native_request_accepted, mode !== 1);
    assert.equal(result.activation.foreground_before, 222);
    assert.equal(result.activation.foreground_after, mode ? 101 : 222);
    assert.equal(result.activation.grant_error, mode ? 0 : 5);
  }
});

test('both native taskbar gates require the actual shell process, exact taskbar class and unobstructed hit target', windowsOnly, async () => {
  for (const text of [source, computerUsePresentationNative]) {
    const method = text.match(/  (?:public )?static bool ShellPoint\(IntPtr hwnd,int x,int y\) \{[\s\S]*?\n  \}/)[0].replace('static bool', 'public static bool').replace('public public', 'public');
    const result = await execute(`Add-Type -TypeDefinition @'
using System;
public static class Gate {
  public struct POINT { public int X,Y; }
  public static uint TargetPid=10,ShellPid=10;
  public static string ClassName="Shell_TrayWnd";
  public static long Hit=101;
  static IntPtr GetShellWindow(){return new IntPtr(99);}
  static uint GetWindowThreadProcessId(IntPtr h,out uint pid){pid=h.ToInt64()==99?ShellPid:TargetPid;return 1;}
  static int GetClassName(IntPtr h,System.Text.StringBuilder name,int length){name.Append(ClassName);return name.Length;}
  static long RootWindowAt(int x,int y){return Hit;}
  static IntPtr WindowFromPoint(POINT p){return new IntPtr(Hit);}
  static IntPtr GetAncestor(IntPtr h,int flags){return h;}
${method}
}
'@
$h=[IntPtr]101; $values=@()
$values += [Gate]::ShellPoint($h,1,1)
[Gate]::ClassName='Shell_SecondaryTrayWnd'; $values += [Gate]::ShellPoint($h,1,1)
[Gate]::ClassName='Editor'; $values += [Gate]::ShellPoint($h,1,1)
[Gate]::ClassName='Shell_TrayWnd'; [Gate]::TargetPid=11; $values += [Gate]::ShellPoint($h,1,1)
[Gate]::TargetPid=10; [Gate]::Hit=102; $values += [Gate]::ShellPoint($h,1,1)
[Gate]::Hit=101; [Gate]::ShellPid=0; $values += [Gate]::ShellPoint($h,1,1)
ConvertTo-Json -InputObject $values -Compress`);
    assert.deepEqual(result, [true, true, false, false, false, false]);
  }
});

test('taskbar exception admits only a coordinate left click and rechecks foreground, process and geometry before dispatch', windowsOnly, async () => {
  const admission = computerUsePresentationNative.match(/if\((Number\(v,"coordinate_click"\)==1[^\n]*)/)[1];
  const check = source.match(/  public static void CheckTarget\(\)\{[\s\S]*?\n  \}/)[0];
  const result = await execute(`Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class Gate {
  public struct RECT { public int Left,Top,Right,Bottom; }
  public static IntPtr ExpectedWindow=new IntPtr(101),ShellForeground=new IntPtr(222),Foreground=new IntPtr(222);
  public static uint ExpectedProcessId=10,Pid=10,ExpectedDpi=96,Dpi=96;
  public static RECT ExpectedBounds=new RECT{Right=100,Bottom=100};
  public static bool ShellClick=true,Hit=true,Moved;
  public static int ShellX,ShellY;
  static string Text(Dictionary<string,object> v,string key){return v.ContainsKey(key)?Convert.ToString(v[key]):"";}
  static long Number(Dictionary<string,object> v,string key){return v.ContainsKey(key)?Convert.ToInt64(v[key]):0;}
  public static bool Admits(int coordinate,string action,string button,int clicks){
    var v=new Dictionary<string,object>{{"coordinate_click",coordinate},{"action",action},{"button",button},{"clicks",clicks}};
    return ${admission};
  }
  static uint GetWindowThreadProcessId(IntPtr h,out uint pid){pid=Pid;return 1;}
  static IntPtr GetForegroundWindow(){return Foreground;}
  static bool ShellPoint(IntPtr h,int x,int y){return Hit;}
  static uint GetDpiForWindow(IntPtr h){return Dpi;}
  static bool GetWindowRect(IntPtr h,out RECT rect){rect=ExpectedBounds;if(Moved)rect.Left++;return true;}
${check}
  public static bool Allowed(){try{CheckTarget();return true;}catch(InvalidOperationException){return false;}}
}
'@
$admission=@([Gate]::Admits(1,'click','left',1),[Gate]::Admits(0,'click','left',1),[Gate]::Admits(1,'key','left',1),[Gate]::Admits(1,'click','right',1),[Gate]::Admits(1,'click','middle',1),[Gate]::Admits(1,'click','left',2))
$values=@([Gate]::Allowed())
[Gate]::Foreground=[IntPtr]333; $values += [Gate]::Allowed()
[Gate]::Foreground=[IntPtr]222; [Gate]::Hit=$false; $values += [Gate]::Allowed()
[Gate]::Hit=$true; [Gate]::Pid=11; $values += [Gate]::Allowed()
[Gate]::Pid=10; [Gate]::Dpi=144; $values += [Gate]::Allowed()
[Gate]::Dpi=96; [Gate]::Moved=$true; $values += [Gate]::Allowed()
[Gate]::Moved=$false; [Gate]::ShellClick=$false; $values += [Gate]::Allowed()
[Gate]::Foreground=[IntPtr]101; $values += [Gate]::Allowed()
[PSCustomObject]@{admission=$admission;dispatch=$values} | ConvertTo-Json -Compress`);
  assert.deepEqual(result.admission, [true, false, false, false, false, false]);
  assert.deepEqual(result.dispatch, [true, false, false, false, false, false, false, true]);
});
