/** Read physical display geometry in the same short-lived native process as
 * capture/input. Observation state pins this topology, never a cached screen index. */
export const computerUseDisplaysScript = String.raw`
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class CardBushDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct INFO {
    public int size; public RECT rect,work; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
  }
  delegate bool MonitorProc(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorProc callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor,ref INFO info);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("shcore.dll")] static extern int GetScaleFactorForMonitor(IntPtr monitor,out int scale);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd,out uint affinity);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out RECT rect,int size);
  [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetInteger(IntPtr hwnd,int attribute,out int value,int size);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  public class Bounds { public int x,y,width,height; }
  public class Display { public string id; public bool primary; public int scale_percent; public Bounds bounds,work_area; }
  static Bounds Convert(RECT r){return new Bounds{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top};}
  static Rectangle RectangleOf(RECT r){return Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);}
  public static void EnableDpi() {
    // Thread awareness also works when a host has already fixed process awareness.
    if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)
      throw new InvalidOperationException("Unable to establish physical-pixel DPI coordinates.");
  }
  public static Display[] Read() {
    var list=new List<Display>();
    bool success=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data)=>{
      var info=new INFO{size=Marshal.SizeOf(typeof(INFO))};
      if(!GetMonitorInfo(monitor,ref info))throw new InvalidOperationException("Unable to read connected displays.");
      int scale;
      if(GetScaleFactorForMonitor(monitor,out scale)!=0)throw new InvalidOperationException("Unable to read display scale.");
      list.Add(new Display{id=info.device,primary=(info.flags&1)!=0,scale_percent=scale,bounds=Convert(info.rect),work_area=Convert(info.work)});
      return true;
    },IntPtr.Zero);
    if(!success || list.Count==0)throw new InvalidOperationException("No interactive displays are available.");
    list.Sort((a,b)=>StringComparer.Ordinal.Compare(a.id,b.id)); return list.ToArray();
  }
  public static string Signature(Display[] displays) {
    var text=new StringBuilder();
    foreach(var d in displays)text.AppendFormat(CultureInfo.InvariantCulture,"{0}:{1}:{2},{3},{4},{5}:{6},{7},{8},{9}:{10};",
      d.id,d.primary,d.bounds.x,d.bounds.y,d.bounds.width,d.bounds.height,d.work_area.x,d.work_area.y,d.work_area.width,d.work_area.height,d.scale_percent);
    using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text.ToString()))).Replace("-","");
  }
  public static uint WindowDpi(IntPtr hwnd){return GetDpiForWindow(hwnd);}
  public static string WindowDisplay(IntPtr hwnd) {
    var info=new INFO{size=Marshal.SizeOf(typeof(INFO))};
    return GetMonitorInfo(MonitorFromWindow(hwnd,0),ref info)?info.device:null;
  }
  public static void AssertUnchanged(string expected,IntPtr hwnd,uint dpi) {
    // A destroyed HWND reports zero DPI. Let the existing window identity check
    // classify it as unavailable instead of misreporting a monitor change.
    uint currentDpi=WindowDpi(hwnd);
    if(!String.IsNullOrEmpty(expected) && (Signature(Read())!=expected || (dpi>0 && currentDpi>0 && currentDpi!=dpi)))
      throw new InvalidOperationException("Display layout or DPI changed after observation. Observe the exact window again.");
  }
  public static bool Uniform(Bitmap image) {
    // A flat interior can be a legitimate blank document. It is a signal to
    // verify via visible capture, never proof of a black-frame failure by itself.
    Color first=image.GetPixel(image.Width/2,image.Height/2);
    for(int y=1;y<=20;y++)for(int x=1;x<=28;x++) {
      Color c=image.GetPixel(Math.Min(image.Width-1,image.Width*(x+3)/35),Math.Min(image.Height-1,image.Height*(y+3)/27));
      if(Math.Abs(c.R-first.R)>2 || Math.Abs(c.G-first.G)>2 || Math.Abs(c.B-first.B)>2)return false;
    } return true;
  }
  static bool Same(RECT a,RECT b){return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom;}
  static bool Visible(IntPtr hwnd,RECT original,Rectangle crop,string signature,uint pid) {
    RECT now; uint currentPid;
    GetWindowThreadProcessId(hwnd,out currentPid);
    if(currentPid!=pid || GetForegroundWindow()!=hwnd || !IsWindowVisible(hwnd) || IsIconic(hwnd) ||
      !GetWindowRect(hwnd,out now) || !Same(original,now) || Signature(Read())!=signature)return false;
    // Reject any intersecting surface above the target, including owned popups
    // and transparent windows. Do not sample a few points and assume the rest is clear.
    int count=0;
    for(IntPtr above=GetWindow(hwnd,3);above!=IntPtr.Zero;above=GetWindow(above,3)) {
      if(++count>4096)return false;
      if(!IsWindowVisible(above) || IsIconic(above))continue;
      int cloaked;if(DwmGetInteger(above,14,out cloaked,4)==0 && cloaked!=0)continue;
      RECT rect;if(!GetWindowRect(above,out rect) || crop.IntersectsWith(RectangleOf(rect)))return false;
    }
    return true;
  }
  public static bool CaptureVisible(IntPtr hwnd,Bitmap target,int left,int top,int width,int height) {
    var original=new RECT{Left=left,Top=top,Right=left+width,Bottom=top+height};
    RECT frame;
    if(DwmGetWindowAttribute(hwnd,9,out frame,Marshal.SizeOf(typeof(RECT)))!=0)return false;
    Rectangle crop=Rectangle.Intersect(RectangleOf(frame),RectangleOf(original));
    if(crop.Width<=0 || crop.Height<=0)return false;
    uint affinity,pid;GetWindowThreadProcessId(hwnd,out pid);
    // Never use another capture path to bypass an application's capture exclusion.
    if(!GetWindowDisplayAffinity(hwnd,out affinity) || affinity!=0)return false;
    var displays=Read();string signature=Signature(displays);
    using(var candidate=new Bitmap(target.Width,target.Height))using(var graphics=Graphics.FromImage(candidate))using(var missing=new Region(crop)) {
      foreach(var display in displays)missing.Exclude(new Rectangle(display.bounds.x,display.bounds.y,display.bounds.width,display.bounds.height));
      if(!missing.IsEmpty(graphics) || !Visible(hwnd,original,crop,signature,pid))return false;
      DwmFlush();
      graphics.Clear(Color.Transparent);
      graphics.CopyFromScreen(crop.Left,crop.Top,crop.Left-left,crop.Top-top,crop.Size,CopyPixelOperation.SourceCopy);
      if(!Visible(hwnd,original,crop,signature,pid))return false;
      using(var destination=Graphics.FromImage(target)) {
        destination.Clear(Color.Transparent);
        destination.DrawImageUnscaled(candidate,0,0);
      }
    }
    return true;
  }
}
'@
[CardBushDesktop]::EnableDpi()
`;

/** Script parameters are private observation data, never values supplied by the model. */
export const computerUseDisplayGuardScript = String.raw`
[CardBushDesktop]::AssertUnchanged($script:CARDBUSH_DISPLAY_SIGNATURE,[IntPtr]([long]$script:CARDBUSH_DISPLAY_HWND),[uint32]$script:CARDBUSH_WINDOW_DPI)
`;
