// Metadata-only host helper. It never executes commands or changes ACLs.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class CardBushProcessHost
{
    private static int RunWorkspacePathGuard(string ownerText)
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var handles = new List<IntPtr>();
        var pinned = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        IntPtr owner = IntPtr.Zero;
        try
        {
            owner = OpenProcess(0x00100000, false, UInt32.Parse(ownerText));
            Check(owner != IntPtr.Zero, "Pin file-access owner");
            IntPtr ownerHandle = owner;
            var watcher = new Thread(delegate() {
                WaitForSingleObject(ownerHandle, INFINITE);
                Environment.Exit(0); // OS closes metadata handles even after a Runtime crash.
            });
            watcher.IsBackground = true; watcher.Start();
            Console.WriteLine("{\"workspacePathGuardVersion\":1}");
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 32768) throw new ArgumentException("File-access request too large.");
                string path = new JavaScriptSerializer().Deserialize<string>(line);
                if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || path.StartsWith(@"\\") ||
                    !String.Equals(path, Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("File-access directories must be canonical local paths.");
                var ancestors = new Stack<string>();
                for (string current = path; current != null && !pinned.Contains(current); current = Path.GetDirectoryName(current))
                    ancestors.Push(current);
                while (ancestors.Count > 0)
                {
                    string current = ancestors.Pop();
                    // Open each component without following reparse points, top down.
                    // Deny write/delete sharing to prevent retargeting or replacing it.
                    IntPtr handle = OpenScopeDirectory(current, 0x00100081, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    Check(handle != new IntPtr(-1), "Pin file-access directory");
                    handles.Add(handle);
                    WorkspaceHandleInformation info;
                    Check(GetWorkspaceHandleInformation(handle, out info), "Inspect file-access directory");
                    if ((info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0)
                        throw new IOException("A file-access directory was replaced or redirected.");
                    pinned.Add(current);
                }
                Console.WriteLine("{\"pinned\":true}");
            }
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        finally
        {
            foreach (IntPtr handle in handles) CloseHandle(handle);
            // The watcher owns the process handle until process exit.
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct WorkspaceHandleInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", SetLastError = true)]
    private static extern bool GetWorkspaceHandleInformation(IntPtr handle, out WorkspaceHandleInformation information);
}
