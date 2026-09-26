# Runs immediately before ShowDialog in the real picker helper. Inspect the
# configured native dialog without opening a window or launching an application.
$ProgressPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class CardBushPickerProbe {
  [DllImport("shell32.dll")]
  private static extern int SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object item, out IntPtr list);
  public static int DesktopItemIdSize(OpenFileDialog dialog) {
    BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
    object native = dialog.GetType().GetMethod("CreateVistaDialog", flags).Invoke(dialog, null);
    object folder = null;
    IntPtr list = IntPtr.Zero;
    try {
      typeof(FileDialog).GetMethod("OnBeforeVistaDialog", flags).Invoke(dialog, new object[] { native });
      Type type = typeof(FileDialog).Assembly.GetType("System.Windows.Forms.FileDialogNative+IFileDialog");
      object[] args = new object[] { null };
      type.GetMethod("GetFolder").Invoke(native, args);
      folder = args[0];
      Marshal.ThrowExceptionForHR(SHGetIDListFromObject(folder, out list));
      // The Shell desktop is the root: its absolute PIDL has no child items.
      // A physical desktop path produces a nonempty PIDL and omits public apps.
      return Marshal.ReadInt16(list);
    } finally {
      if (list != IntPtr.Zero) Marshal.FreeCoTaskMem(list);
      if (folder != null) Marshal.ReleaseComObject(folder);
      Marshal.ReleaseComObject(native);
    }
  }
}
'@
$itemIdSize = [CardBushPickerProbe]::DesktopItemIdSize($chooser)
$shell = New-Object -ComObject Shell.Application
try {
  $desktopPaths = @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
  $physicalShortcuts = @($desktopPaths | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
      Get-ChildItem -LiteralPath $_ -File | Where-Object { $_.Extension -in '.lnk', '.url' } | ForEach-Object { $_.FullName }
    }
  })
  $visibleShortcuts = @($shell.NameSpace(0).Items() | Where-Object { [IO.Path]::GetExtension($_.Path) -in '.lnk', '.url' } | ForEach-Object { $_.Path })
  [Console]::Out.Write((@{
    itemIdSize = $itemIdSize
    dereferenceLinks = $chooser.DereferenceLinks
    filter = $chooser.Filter
    physicalShortcuts = $physicalShortcuts
    visibleShortcuts = $visibleShortcuts
  } | ConvertTo-Json -Compress))
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
exit 0
