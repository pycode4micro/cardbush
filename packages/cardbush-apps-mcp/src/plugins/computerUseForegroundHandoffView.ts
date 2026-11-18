// Native view only: the controller supplies localized text and bounded callbacks.
export const computerUseForegroundHandoffView = String.raw`
  sealed class ForegroundHandoffView : Form {
    public ForegroundHandoffView(string title,string body,string activate,string cancel,IntPtr hwnd,Action confirm,Action dismiss) {
      Text=title; ShowInTaskbar=true; TopMost=true; FormBorderStyle=FormBorderStyle.FixedDialog;
      Font=SystemFonts.MessageBoxFont;
      AutoScaleMode=AutoScaleMode.Dpi; AutoSize=true; AutoSizeMode=AutoSizeMode.GrowAndShrink;
      StartPosition=FormStartPosition.Manual; MaximizeBox=false; MinimizeBox=false;
      var layout=new FlowLayoutPanel { FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=true,Padding=new Padding(16) };
      var message=new Label { Text=body,AutoSize=true,MaximumSize=new Size(360,0),Margin=new Padding(0,0,0,12) };
      var actions=new FlowLayoutPanel { AutoSize=true,WrapContents=false,Margin=new Padding(0) };
      var yes=new Button { Text=activate,AutoSize=true };
      var no=new Button { Text=cancel,AutoSize=true };
      yes.Click+=(s,e)=>confirm(); no.Click+=(s,e)=>dismiss();
      actions.Controls.Add(yes); actions.Controls.Add(no); layout.Controls.Add(message); layout.Controls.Add(actions); Controls.Add(layout);
      AcceptButton=yes; CancelButton=no;
      FormClosing+=(s,e)=>dismiss();
      Shown+=(s,e)=>{var area=Screen.FromHandle(hwnd).WorkingArea;Location=new Point(area.Right-Width-16,area.Bottom-Height-16);};
    }
    protected override bool ShowWithoutActivation { get { return true; } }
  }
`;
