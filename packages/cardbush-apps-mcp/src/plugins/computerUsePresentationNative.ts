// Private Windows presentation worker. This source travels with the plugin's
// compiled JS, so packaging does not depend on Electron or extra host assets.
export const computerUsePresentationNative = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class CardBushPresentation {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public POINT pt; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public uint key, scan, flags, time; public UIntPtr extra; }
  delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
  delegate IntPtr InputHook(int code, IntPtr msg, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, InputHook callback, IntPtr module, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr msg, IntPtr data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW")] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

  static Form dispatcher;
  static Layer frame, badge;
  static IntPtr target;
  static string scope = "";
  static bool paused, suspended, pointer, active, closing;
  static DateTime touched, entered, lastHuman = DateTime.MinValue, fadeStarted;
  static float pointerX, pointerY;
  static bool click;
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static readonly object outputLock = new object();
  static readonly List<IntPtr> eventHooks = new List<IntPtr>();
  static WinEvent onWindow;
  static InputHook onMouse, onKey;
  static IntPtr mouseHook, keyHook;
  static readonly UIntPtr inputTag=new UIntPtr(0x43425553);
  static readonly HashSet<byte> heldKeys=new HashSet<byte>();
  static uint heldMouse;
  [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,int data,UIntPtr extra);
  // Only release our tagged synthetic input, never arbitrary user-held keys.
  static void ReleaseInput() {
    byte[] keys=new byte[heldKeys.Count]; heldKeys.CopyTo(keys); heldKeys.Clear();
    uint mouse=heldMouse; heldMouse=0;
    foreach(byte key in keys) keybd_event(key,0,2,inputTag);
    if(mouse!=0) mouse_event(mouse,0,0,0,inputTag);
  }
  static System.Windows.Forms.Timer timer;

  static void Emit(object value) { lock(outputLock) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
  static string Text(Dictionary<string,object> v, string key) { return v.ContainsKey(key) ? Convert.ToString(v[key]) : ""; }
  static long Number(Dictionary<string,object> v, string key) { return v.ContainsKey(key) && v[key] != null ? Convert.ToInt64(v[key]) : 0; }
  static void Stop(string reason) {
    if (!active) return;
    Emit(new { kind="stopped", scope=scope, reason=reason });
    active = false; pointer = false; closing = true; fadeStarted = DateTime.UtcNow;
    ReleaseInput();
    timer.Interval = 30;
  }
  static void Human(bool escape) {
    lastHuman = DateTime.UtcNow;
    if (!active) return;
    if (escape) { Stop("escape"); return; }
    if (!paused) {
      paused=true; pointer=false;
      ReleaseInput();
      Emit(new { kind="paused", scope=scope });
      Redraw();
    }
  }
  static void Redraw() {
    byte opacity=closing ? (byte)Math.Max(0,255*(1-(DateTime.UtcNow-fadeStarted).TotalMilliseconds/180)) : (byte)255;
    if(frame!=null) { SetLayeredWindowAttributes(frame.Handle,0xFF00FF,opacity,3); frame.Invalidate(); }
    if(badge!=null) { SetLayeredWindowAttributes(badge.Handle,0xFF00FF,opacity,3); badge.Invalidate(); }
  }
  static void HideLayers() { if(frame!=null) frame.Hide(); if(badge!=null) badge.Hide(); }
  static void SyncWindow() {
    if (frame==null || badge==null) return;
    if (!IsWindow(target)) { Stop("window_closed"); HideLayers(); return; }
    // A child of the target cannot float over another application's window.
    // Foreground loss also hides both surfaces (including minimized windows).
    if (suspended || (!active && !closing) || IsIconic(target) || GetAncestor(GetForegroundWindow(),2)!=target) {
      HideLayers(); return;
    }
    RECT r;
    if(!GetClientRect(target,out r) || r.Right<80 || r.Bottom<40) { HideLayers(); return; }
    SetWindowPos(frame.Handle,IntPtr.Zero,0,0,r.Right,r.Bottom,0x0010|0x0040);
    int width=Math.Min(244,r.Right-12);
    SetWindowPos(badge.Handle,IntPtr.Zero,Math.Max(6,r.Right-width-12),10,width,32,0x0010|0x0040);
    Redraw();
  }
  static Layer MakeLayer(bool isBadge) {
    Layer layer=new Layer(isBadge);
    IntPtr handle=layer.Handle;
    SetWindowLong(handle,-16,(GetWindowLong(handle,-16)&unchecked((int)~0x80000000))|0x40000000);
    SetParent(handle,target);
    if(GetParent(handle)!=target) {
      layer.Dispose();
      throw new Exception("Cannot attach Computer Use presentation to this window. Control was not started.");
    }
    return layer;
  }
  static void Bind(IntPtr hwnd) {
    if(target==hwnd && frame!=null) return;
    if(frame!=null) frame.Dispose(); if(badge!=null) badge.Dispose();
    target=hwnd; entered=DateTime.UtcNow;
    frame=MakeLayer(false); badge=MakeLayer(true);
  }
  static void Command(Dictionary<string,object> v) {
    long id=Number(v,"id"); string op=Text(v,"op"), requestScope=Text(v,"scope");
    try {
      if(op=="shutdown") { Application.ExitThread(); return; }
      if(op=="suspend") { suspended=true; HideLayers(); }
      else if(op=="restore") { suspended=false; SyncWindow(); }
      else if(op=="finish") {
        if(scope==requestScope) { ReleaseInput(); active=false; pointer=false; closing=true; fadeStarted=DateTime.UtcNow; timer.Interval=30; }
      } else if(op=="observe") {
        if (active && scope!=requestScope) throw new Exception("Another session owns the Computer Use window. Finish that control session first.");
        if (!IsWindow(new IntPtr(Number(v,"hwnd")))) throw new Exception("The target window no longer exists.");
        bool newScope=scope!=requestScope;
        if(newScope) paused=false;
        scope=requestScope; active=true; closing=false; suspended=false; pointer=false;
        Bind(new IntPtr(Number(v,"hwnd")));
        if (paused && (DateTime.UtcNow-lastHuman).TotalMilliseconds>=1200) paused=false;
        touched=DateTime.UtcNow; timer.Interval=250; SyncWindow();
      } else if(op=="action") {
        if(!active || scope!=requestScope || target.ToInt64()!=Number(v,"hwnd")) throw new Exception("Observe the exact target window before control.");
        if(paused) throw new Exception("User has taken over. Observe again after the user finishes.");
        if(Text(v,"action")!="window" && GetAncestor(GetForegroundWindow(),2)!=target) throw new Exception("The observed window is no longer foreground. Observe it again.");
        pointer=v.ContainsKey("x") && v["x"]!=null && v.ContainsKey("y") && v["y"]!=null;
        if(pointer) {
          RECT wr; POINT origin=new POINT(); GetWindowRect(target,out wr); ClientToScreen(target,ref origin);
          pointerX=Number(v,"x")+wr.Left-origin.X; pointerY=Number(v,"y")+wr.Top-origin.Y;
        }
        click=Text(v,"action")=="click" || Text(v,"action")=="invoke";
        touched=DateTime.UtcNow; suspended=false; Redraw(); SyncWindow();
      } else if(op=="idle") { if(scope==requestScope) { ReleaseInput(); pointer=false; touched=DateTime.UtcNow; Redraw(); } }
      else if(op=="pause") { if(scope==requestScope) Human(false); }
      Emit(new { kind="ack", id=id, paused=paused });
    } catch(Exception ex) { Emit(new { kind="ack", id=id, error=ex.Message }); }
  }
  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
    Application.EnableVisualStyles();
    dispatcher=new Form(); IntPtr handle=dispatcher.Handle;
    onWindow=(hook,evt,hwnd,obj,child,thread,time)=> {
      if(evt==3 || (hwnd==target && obj==0)) SyncWindow();
    };
    eventHooks.Add(SetWinEventHook(3,3,IntPtr.Zero,onWindow,0,0,2));
    eventHooks.Add(SetWinEventHook(0x8001,0x800B,IntPtr.Zero,onWindow,0,0,2));
    onMouse=(code,msg,data)=> {
      if(code>=0) {
        MOUSE input=(MOUSE)Marshal.PtrToStructure(data,typeof(MOUSE));
        if(input.extra==inputTag) {
          long message=msg.ToInt64();
          if(message==0x201) heldMouse|=4; else if(message==0x202) heldMouse&=~4u;
          if(message==0x204) heldMouse|=16; else if(message==0x205) heldMouse&=~16u;
          if(message==0x207) heldMouse|=64; else if(message==0x208) heldMouse&=~64u;
        }
        if((input.flags&1)==0) Human(false);
      }
      return CallNextHookEx(IntPtr.Zero,code,msg,data);
    };
    onKey=(code,msg,data)=> {
      if(code>=0) {
        KEY input=(KEY)Marshal.PtrToStructure(data,typeof(KEY));
        if(input.extra==inputTag && input.key!=0xE7) {
          if((input.flags&0x80)==0) heldKeys.Add((byte)input.key); else heldKeys.Remove((byte)input.key);
        }
        if((input.flags&0x10)==0 && (msg.ToInt64()==0x100 || msg.ToInt64()==0x104)) Human(input.key==27);
      }
      return CallNextHookEx(IntPtr.Zero,code,msg,data);
    };
    mouseHook=SetWindowsHookEx(14,onMouse,GetModuleHandle(null),0);
    keyHook=SetWindowsHookEx(13,onKey,GetModuleHandle(null),0);
    if(mouseHook==IntPtr.Zero || keyHook==IntPtr.Zero) throw new Exception("Unable to register Computer Use take-over hooks.");
    timer=new System.Windows.Forms.Timer(); timer.Interval=250;
    timer.Tick+=(s,e)=> {
      if(closing) {
        if((DateTime.UtcNow-fadeStarted).TotalMilliseconds>=180) { closing=false; HideLayers(); timer.Interval=250; }
        else Redraw();
      } else if(active && (DateTime.UtcNow-touched).TotalSeconds>120) Stop("idle_timeout");
      else if(active && (DateTime.UtcNow-entered).TotalMilliseconds<1000) Redraw();
    };
    timer.Start();
    Thread reader=new Thread(()=> {
      try {
        string line;
        while((line=Console.ReadLine())!=null) {
          var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);
          dispatcher.BeginInvoke(new Action(()=>Command(value)));
        }
      } catch {}
      try { dispatcher.BeginInvoke(new Action(()=>Application.ExitThread())); } catch {}
    });
    reader.IsBackground=true; reader.Start(); Emit(new {kind="ready"});
    try { Application.Run(); }
    finally {
      ReleaseInput();
      timer.Dispose(); UnhookWindowsHookEx(mouseHook); UnhookWindowsHookEx(keyHook);
      foreach(IntPtr hook in eventHooks) UnhookWinEvent(hook);
      if(frame!=null) frame.Dispose(); if(badge!=null) badge.Dispose(); dispatcher.Dispose();
    }
  }
  sealed class Layer : Form {
    readonly bool isBadge;
    public Layer(bool value) {
      isBadge=value; FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false;
      BackColor=Color.Magenta; TransparencyKey=Color.Magenta;
      SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var p=base.CreateParams; p.ExStyle|=0x08000000|0x80|0x80000; if(!isBadge) p.ExStyle|=0x20; return p; }
    }
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x21) { m.Result=new IntPtr(3); return; }
      if(!isBadge && m.Msg==0x84) { m.Result=new IntPtr(-1); return; }
      base.WndProc(ref m);
    }
    protected override void OnMouseUp(MouseEventArgs e) { if(isBadge && e.Button==MouseButtons.Left && e.X>=Width-55) Stop("button"); }
    protected override void OnPaint(PaintEventArgs e) {
      var g=e.Graphics; g.SmoothingMode=SmoothingMode.None;
      Color cyan=(DateTime.UtcNow-entered).TotalMilliseconds<450 ? Color.FromArgb(63,212,207) : Color.FromArgb(47,116,117);
      if(isBadge) {
        using(var bg=new SolidBrush(Color.FromArgb(20,29,31))) g.FillRoundedRectangle(bg,0,0,Width,Height,12);
        using(var pen=new Pen(cyan)) g.DrawRectangle(pen,0,0,Width-1,Height-1);
        using(var font=new Font("Segoe UI",9)) {
          TextRenderer.DrawText(g,paused?"CardBush · 已暂停":"CardBush 操作中",font,new Point(10,7),Color.FromArgb(212,226,225));
          TextRenderer.DrawText(g,"停止",font,new Point(Width-43,7),Color.FromArgb(90,223,215));
        }
      } else {
        using(var pen=new Pen(cyan,2)) g.DrawRectangle(pen,1,1,Math.Max(0,Width-3),Math.Max(0,Height-3));
        if(pointer && !paused && pointerX>=0 && pointerY>=0 && pointerX<Width && pointerY<Height) {
          float x=pointerX,y=pointerY;
          var points=new PointF[]{new PointF(x,y),new PointF(x+5,y+20),new PointF(x+10,y+13),new PointF(x+20,y+9)};
          using(var fill=new SolidBrush(Color.FromArgb(42,177,179))) g.FillPolygon(fill,points);
          using(var pen=new Pen(Color.FromArgb(228,255,251),1.4f)) g.DrawPolygon(pen,points);
          float labelX=Math.Max(3,Math.Min(Width-84,x+15)); float labelY=y+22;
          if(labelY+24>Height) labelY=Math.Max(3,y-27);
          using(var fill=new SolidBrush(Color.FromArgb(29,132,139))) g.FillRoundedRectangle(fill,labelX,labelY,80,24,11);
          using(var font=new Font("Segoe UI",8,FontStyle.Bold)) g.DrawString("CardBush",font,Brushes.White,labelX+8,labelY+5);
          if(click) { using(var pen=new Pen(Color.FromArgb(47,116,117),1)) g.DrawEllipse(pen,x-6,y-6,12,12); }
        }
      }
    }
  }
  static void FillRoundedRectangle(this Graphics g, Brush brush,float x,float y,float w,float h,float r) {
    using(var path=new GraphicsPath()) {
      path.AddArc(x,y,r,r,180,90); path.AddArc(x+w-r,y,r,r,270,90);
      path.AddArc(x+w-r,y+h-r,r,r,0,90); path.AddArc(x,y+h-r,r,r,90,90); path.CloseFigure(); g.FillPath(brush,path);
    }
  }
}
`;
