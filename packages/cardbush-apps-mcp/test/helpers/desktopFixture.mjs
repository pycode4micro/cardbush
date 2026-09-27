import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// The fixture owns all windows and controls touched by the adversarial suite.
// Its independent IPC reports application state, rather than trusting tool ACKs.
const source = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
public static class DesktopFixture {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  delegate bool EnumProc(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static Window main, cover, popup;
  static TextBox input, readOnly, coverInput, fileName;
  static Button button;
  static CheckBox toggle;
  static Slider slider;
  static PasswordBox password;
  static ScrollViewer scroll;
  static Border drag;
  static int count, dragMoves, wheels, switchAfter;
  static bool dragging, popupOnClick;
  static DataObject clipboardBackup;
  static string expectedClipboardText, clipboardRestore="not_requested";
  static string[] expectedClipboardFiles;
  static string[] pastedFiles=new string[0];
  static void Emit(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
  static T Identify<T>(T element,string id) where T:DependencyObject { AutomationProperties.SetAutomationId(element,id); return element; }
  static void State(string kind,string op) {
    POINT cursor; GetCursorPos(out cursor);
    Emit(new { kind=kind, op=op, hwnd=new WindowInteropHelper(main).Handle.ToInt64(),
      cover=new WindowInteropHelper(cover).Handle.ToInt64(), popup=popup==null?0:new WindowInteropHelper(popup).Handle.ToInt64(), foreground=GetForegroundWindow().ToInt64(),
      text=input.Text, fileName=fileName==null?"":fileName.Text, coverText=coverInput.Text, readOnly=readOnly.Text, passwordLength=password.Password.Length,
      count=count, windowState=main.WindowState.ToString(), toggled=toggle.IsChecked, slider=slider.Value, dragMoves=dragMoves,
      scroll=scroll.VerticalOffset, wheels=wheels, x=cursor.x, y=cursor.y, pastedFiles=pastedFiles, clipboardRestore=clipboardRestore });
  }
  static void RestoreClipboard() {
    if(clipboardBackup==null)return;
    bool owned=expectedClipboardText!=null && Clipboard.GetText()==expectedClipboardText;
    if(expectedClipboardFiles!=null && Clipboard.ContainsFileDropList()) {
      var actual=Clipboard.GetFileDropList();owned=actual.Count==expectedClipboardFiles.Length;
      if(owned)for(int i=0;i<actual.Count;i++)if(actual[i]!=expectedClipboardFiles[i])owned=false;
    }
    if(owned){Clipboard.SetDataObject(clipboardBackup,true);clipboardRestore="restored";}
    else clipboardRestore="unchanged_or_replaced";
    clipboardBackup=null;
  }
  [STAThread] public static void Run() {
    Application app=new Application(); app.ShutdownMode=ShutdownMode.OnMainWindowClose;
    main=new Window {Title="CardBush isolated adversarial fixture",Left=80,Top=100,Width=780,Height=660};
    main.Closing+=(s,e)=>{try{RestoreClipboard();}catch(Exception ex){Emit(new {kind="cleanup_error",error=ex.Message});}};
    cover=new Window {Title="CardBush isolated cover fixture",Left=950,Top=100,Width=320,Height=240};
    coverInput=new TextBox {Text="COVER MUST NOT RECEIVE INPUT",AcceptsReturn=true}; cover.Content=coverInput;
    StackPanel panel=new StackPanel {Margin=new Thickness(24)}; main.Content=panel;
    input=Identify(new TextBox {Text="",Height=60,AcceptsReturn=true},"fixture-input"); panel.Children.Add(input);
    input.PreviewKeyDown+=(s,e)=>{
      if(e.Key==Key.V && (Keyboard.Modifiers&ModifierKeys.Control)!=0 && Clipboard.ContainsFileDropList()) {
        var files=Clipboard.GetFileDropList();pastedFiles=new string[files.Count];files.CopyTo(pastedFiles,0);e.Handled=true;
      }
    };
    input.TextChanged+=(s,e)=>{if(switchAfter>0&&input.Text.Length>=switchAfter){switchAfter=0;cover.Show();cover.Activate();coverInput.Focus();coverInput.CaretIndex=coverInput.Text.Length;}};
    button=Identify(new Button {Content="Increment 0",Height=35},"fixture-button");
    button.Click+=(s,e)=>{
      count++;button.Content="Increment "+count;
      if(popupOnClick) {
        popupOnClick=false;
        popup=new Window {Title="",Owner=main,Left=main.Left+120,Top=main.Top+140,Width=340,Height=160};
        Button close=Identify(new Button {Content="Close owned popup",Margin=new Thickness(25)},"fixture-popup-close");
        close.Click+=(ps,pe)=>popup.Close(); popup.Content=close; popup.Show();popup.Activate();
      }
    }; panel.Children.Add(button);
    toggle=Identify(new CheckBox {Content="Toggle fixture",Height=28},"fixture-toggle"); panel.Children.Add(toggle);
    slider=Identify(new Slider {Minimum=0,Maximum=100,Value=20,Height=30},"fixture-slider"); panel.Children.Add(slider);
    readOnly=Identify(new TextBox {Text="READ ONLY",IsReadOnly=true,Height=30},"fixture-readonly"); panel.Children.Add(readOnly);
    password=Identify(new PasswordBox {Password="fixture-secret",Height=30},"fixture-password"); panel.Children.Add(password);
    drag=Identify(new Border {Height=70,Background=Brushes.CornflowerBlue},"fixture-drag");
    drag.Child=new TextBlock {Text="Drag only inside this fixture",FontSize=16};
    drag.MouseLeftButtonDown+=(s,e)=>{dragging=true;drag.CaptureMouse();};
    drag.MouseMove+=(s,e)=>{if(dragging){dragMoves++;drag.Child=new TextBlock {Text="Drag moves "+dragMoves};}};
    drag.MouseLeftButtonUp+=(s,e)=>{dragging=false;drag.ReleaseMouseCapture();}; panel.Children.Add(drag);
    scroll=Identify(new ScrollViewer {Height=180,VerticalScrollBarVisibility=ScrollBarVisibility.Visible},"fixture-scroll");
    StackPanel rows=new StackPanel(); for(int i=0;i<50;i++)rows.Children.Add(new TextBlock {Text="Scroll fixture row "+i,Height=25});
    scroll.Content=rows; scroll.PreviewMouseWheel+=(s,e)=>wheels++; panel.Children.Add(scroll);
    main.ContentRendered+=(s,e)=>{main.Activate();input.Focus();State("ready","");};
    main.Closed+=(s,e)=>cover.Close();
    Thread reader=new Thread(()=> {
      string line;
      while((line=Console.ReadLine())!=null) {
        var v=json.Deserialize<Dictionary<string,object>>(line);
        main.Dispatcher.BeginInvoke(new Action(()=> {
          string op=Convert.ToString(v["op"]);
          try {
            if(op=="quit"){main.Close();return;}
            if(op=="saveClipboard") {
              var original=Clipboard.GetDataObject();var saved=new DataObject();
              if(original!=null)foreach(string format in original.GetFormats(false)) {
                object data=original.GetData(format,false);
                var stream=data as System.IO.MemoryStream;
                if(stream!=null)data=new System.IO.MemoryStream(stream.ToArray());
                if(data!=null)saved.SetData(format,data,false);
              }
              clipboardBackup=saved;
            }
            if(op=="expectClipboard") {
              expectedClipboardText=v.ContainsKey("text")?Convert.ToString(v["text"]):null;
              expectedClipboardFiles=null;
              if(v.ContainsKey("files")){var values=(System.Collections.ArrayList)v["files"];expectedClipboardFiles=new string[values.Count];for(int i=0;i<values.Count;i++)expectedClipboardFiles[i]=Convert.ToString(values[i]);}
            }
            if(op=="restoreClipboard")RestoreClipboard();
            if(op=="activate"){main.WindowState=WindowState.Normal;main.Activate();input.Focus();}
            if(op=="background"){cover.Show();cover.Activate();}
            if(op=="overlap"){cover.Left=main.Left+40;cover.Top=main.Top+100;cover.Show();cover.Topmost=true;main.Activate();}
            if(op=="uncover"){cover.Topmost=false;cover.Hide();main.Activate();}
            if(op=="move") main.Left+=25;
            if(op=="resize") main.Width+=25;
            if(op=="minimize") main.WindowState=WindowState.Minimized;
            if(op=="setText") input.Text=Convert.ToString(v["text"]);
            if(op=="focusInput") input.Focus();
            if(op=="switchDuringTyping"){input.Text="";input.Focus();switchAfter=v.ContainsKey("after")?Convert.ToInt32(v["after"]):20;}
            if(op=="disableButton") button.IsEnabled=false;
            if(op=="enableButton") button.IsEnabled=true;
            if(op=="renameButton") button.Content="Changed identity";
            if(op=="resetButton") button.Content="Increment "+count;
            if(op=="popupOnClick") popupOnClick=true;
            if(op=="fileDialog") {
              popup=new Window {Title="CardBush isolated file dialog",Owner=main,Left=100,Top=100,Width=900,Height=610};
              StackPanel contents=new StackPanel {Margin=new Thickness(24)};
              WrapPanel files=new WrapPanel {Height=420};
              for(int i=0;i<150;i++) files.Children.Add(Identify(new TextBlock {Text="Reference file "+i,Width=106,Height=20},"file-row-"+i));
              contents.Children.Add(files);
              fileName=Identify(new TextBox {Height=32},"fixture-file-name");
              AutomationProperties.SetName(fileName,"File name 文件名"); contents.Children.Add(fileName);
              Button open=Identify(new Button {Content="Open 打开",Height=32},"fixture-file-open");
              open.Click+=(s,e)=>popup.Close();contents.Children.Add(open);
              popup.Content=contents;popup.Show();popup.Activate();
            }
            if(op=="closePopup" && popup!=null) popup.Close();
            if(op=="stopControl") {
              IntPtr target=new WindowInteropHelper(main).Handle;
              EnumChildWindows(target,(h,p)=>{RECT r;GetWindowRect(h,out r);if(r.b-r.t==32)PostMessage(h,0x202,IntPtr.Zero,new IntPtr((16<<16)|(r.r-r.l-20)));return true;},IntPtr.Zero);
            }
            if(op=="reset"){input.Text="";input.Focus();}
            State("ack",op);
          }catch(Exception ex){Emit(new {kind="ack",op=op,error=ex.Message});}
        }));
      }
      try{main.Dispatcher.BeginInvoke(new Action(()=>main.Close()));}catch{}
    });
    reader.IsBackground=true;reader.Start();app.Run(main);
  }
}`;

export function launchDesktopFixture() {
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CB_FIXTURE_SOURCE))) -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Web.Extensions; [DesktopFixture]::Run()";
  const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {
    windowsHide:true, stdio:'pipe', env:{...process.env,CB_FIXTURE_SOURCE:Buffer.from(source).toString('base64')},
  });
  let stderr=''; const queued=[]; const waiting=[];
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-5000);});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const value=JSON.parse(line);const waiter=waiting.shift();if(waiter)waiter.resolve(value);else queued.push(value);}catch{}});
  child.once('exit',code=>{for(const waiter of waiting.splice(0))waiter.reject(new Error(`Fixture exited ${code}: ${stderr}`));lines.close();});
  const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise((resolve,reject)=>{
    const waiter={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};
    const timer=setTimeout(()=>{const index=waiting.indexOf(waiter);if(index>=0)waiting.splice(index,1);reject(new Error(`Fixture timed out: ${stderr}`));},15000);
    waiting.push(waiter);
  });
  return { child, ready:next(), async command(op,extra={}) {child.stdin.write(JSON.stringify({op,...extra})+'\n');const value=await next();if(value.error)throw new Error(value.error);return value;},
    close(){child.stdin.end();const timeout=setTimeout(()=>child.kill(),3000);timeout.unref();child.once('exit',()=>clearTimeout(timeout));},
  };
}
