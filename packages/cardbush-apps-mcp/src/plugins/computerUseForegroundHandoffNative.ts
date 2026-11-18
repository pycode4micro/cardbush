export const computerUseForegroundHandoffNative = String.raw`
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd,int command);
  static ForegroundHandoffView handoff;
  static string activationId="", activationPhase="idle", activationScope="";
  static IntPtr activationTarget;
  static uint activationPid;
  static long activationStart;
  static DateTime activationExpires,activationDeadline;
  static object ActivationSnapshot() {
    return new { request_id=activationId,state=activationPhase,target_hwnd=activationTarget.ToInt64(),target_process_id=activationPid,
      expires_at=activationExpires.ToUniversalTime().ToString("o"),foreground_hwnd=GetForegroundWindow().ToInt64() };
  }
  static bool ActivationTargetValid() {
    uint pid;
    if(!active || scope!=activationScope || target!=activationTarget || !IsWindow(activationTarget))return false;
    GetWindowThreadProcessId(activationTarget,out pid);
    if(pid!=activationPid)return false;
    try{return System.Diagnostics.Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks==activationStart;}catch{return false;}
  }
  static void SettleActivation(string phase) {
    if(activationPhase!="waiting" && activationPhase!="activating")return;
    activationPhase=phase;
    var view=handoff;handoff=null;
    if(view!=null){view.Close();view.Dispose();}
    Emit(new {kind="activation",scope=activationScope,activation=ActivationSnapshot()});
  }
  static void AdvanceActivation() {
    if(activationPhase!="waiting" && activationPhase!="activating")return;
    if(!ActivationTargetValid()){SettleActivation("target_changed");return;}
    if(DateTime.UtcNow>=activationExpires){SettleActivation("expired");return;}
    if(activationPhase=="activating") {
      if(GetForegroundWindow()==activationTarget)SettleActivation("activated");
      else if(DateTime.UtcNow>=activationDeadline)SettleActivation("denied");
    }
  }
  static object RequestActivation(Dictionary<string,object> v) {
    uint pid;
    var hwnd=new IntPtr(Number(v,"hwnd"));
    GetWindowThreadProcessId(hwnd,out pid);
    if(!active || scope!=Text(v,"scope") || target!=hwnd || pid==0 || pid!=(uint)Number(v,"process_id"))
      throw new Exception("The activation target is no longer owned by this control session.");
    AdvanceActivation();
    if((activationPhase=="waiting" || activationPhase=="activating") && activationTarget==hwnd && activationScope==scope)return ActivationSnapshot();
    SettleActivation("superseded");
    activationId=Guid.NewGuid().ToString();activationScope=scope;activationTarget=hwnd;activationPid=pid;
    activationStart=System.Diagnostics.Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks;
    activationExpires=DateTime.UtcNow.AddSeconds(30);activationPhase="waiting";
    handoff=new ForegroundHandoffView(Text(v,"title"),Text(v,"body"),Text(v,"activate"),Text(v,"cancel"),hwnd,()=> {
      // This callback runs on the thread receiving the real user's click. The
      // qualification belongs here, not to an unrelated background worker.
      if(!ActivationTargetValid() || DateTime.UtcNow>=activationExpires){SettleActivation("expired");return;}
      if(activationPhase!="waiting")return;
      activationPhase="activating";activationDeadline=DateTime.UtcNow.AddSeconds(1);
      if(IsIconic(activationTarget))ShowWindowAsync(activationTarget,9);
      SetForegroundWindow(activationTarget);
      AdvanceActivation();
    },()=>SettleActivation("cancelled"));
    handoff.Show();
    return ActivationSnapshot();
  }
`;
