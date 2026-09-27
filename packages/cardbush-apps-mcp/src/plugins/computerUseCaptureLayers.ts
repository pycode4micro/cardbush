// Private properties shared by the presentation worker and capture processes.
// They identify our child surfaces; application controls are never hidden.
export const controlLayerMarker = 'CardBush.ControlLayer.v1';
export const controlLayerEnabled = 'CardBush.ControlLayer.Enabled.v1';
export const controlLayerCapture = 'CardBush.ControlLayer.Capture.v1';

export const computerUseCaptureLayersScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CardBushCaptureLayers {
  delegate bool EnumProc(IntPtr hwnd,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr hwnd,string name);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool SetProp(IntPtr hwnd,string name,IntPtr value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr hwnd,string name);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  public static bool IsLayerOrChild(IntPtr hwnd) {
    for(int depth=0;hwnd!=IntPtr.Zero && depth<32;depth++,hwnd=GetParent(hwnd))
      if(GetProp(hwnd,"${controlLayerMarker}")!=IntPtr.Zero) return true;
    return false;
  }
  public static long[] Hide(IntPtr target) {
    var candidates=new List<IntPtr>();
    EnumProc collect=(hwnd,p)=>{
      if(GetProp(hwnd,"${controlLayerMarker}")!=IntPtr.Zero && IsWindowVisible(hwnd)) candidates.Add(hwnd);
      return true;
    };
    if(target==IntPtr.Zero) EnumWindows((hwnd,p)=>{EnumChildWindows(hwnd,collect,IntPtr.Zero);return true;},IntPtr.Zero);
    else EnumChildWindows(target,collect,IntPtr.Zero);
    var hidden=new List<long>();
    try {
      foreach(IntPtr hwnd in candidates) {
        if(!IsWindow(hwnd)) continue;
        if(!SetProp(hwnd,"${controlLayerCapture}",new IntPtr(1))) throw new InvalidOperationException("Unable to mask the Computer Use surface for capture.");
        hidden.Add(hwnd.ToInt64());
        ShowWindow(hwnd,0);
        if(IsWindowVisible(hwnd)) throw new InvalidOperationException("Computer Use surface remained visible during capture.");
      }
      return hidden.ToArray();
    } catch { Restore(hidden.ToArray()); throw; }
  }
  public static void Restore(long[] handles) {
    foreach(long value in handles) {
      IntPtr hwnd=new IntPtr(value);
      if(!IsWindow(hwnd)) continue;
      RemoveProp(hwnd,"${controlLayerCapture}");
      IntPtr parent=GetParent(hwnd);
      // A concurrent Stop/finish revokes Enabled. Never resurrect its surfaces.
      if(GetProp(hwnd,"${controlLayerEnabled}")!=IntPtr.Zero && IsWindowVisible(parent) && !IsIconic(parent)) ShowWindow(hwnd,4);
    }
  }
}
'@
`;
