// Content I/O runs as an AppContainer child of the normal process supervisor.
// The pipe protocol exposes one checked file handle, never arbitrary commands.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static partial class CardBushProcessHost
{
    private static Dictionary<string, object> WorkspaceFileStat(FileStream stream)
    {
        WorkspaceHandleInformation info;
        Check(GetWorkspaceHandleInformation(stream.SafeFileHandle.DangerousGetHandle(), out info), "Inspect workspace file");
        WorkspaceBasicInformation basic;
        Check(GetWorkspaceBasicInformation(stream.SafeFileHandle.DangerousGetHandle(), 0, out basic, (uint)Marshal.SizeOf(typeof(WorkspaceBasicInformation))), "Inspect workspace file timestamps");
        if ((info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1) throw new IOException("workspace_authorization_changed");
        return new Dictionary<string, object> {
            { "dev", info.VolumeSerial.ToString() }, { "ino", (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString() },
            { "size", stream.Length.ToString() }, { "mtimeNs", ((((long)info.WriteTime.dwHighDateTime << 32) | (uint)info.WriteTime.dwLowDateTime) - 116444736000000000L).ToString() + "00" },
            { "ctimeNs", ((basic.ChangeTime - 116444736000000000L) * 100L).ToString() }, { "nlink", info.Links.ToString() }
        };
    }

    private static int RunWorkspaceFileWorker()
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var json = new JavaScriptSerializer { MaxJsonLength = 128 * 1024 };
        FileStream file = null;
        bool writable = false, deleting = false;
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 128 * 1024) throw new IOException("File protocol budget exceeded.");
                try
                {
                    var input = json.Deserialize<Dictionary<string, object>>(line);
                    string operation = Convert.ToString(input["op"]);
                    object result = null;
                    if (operation == "open" && file == null)
                    {
                        string path = Convert.ToString(input["path"]);
                        writable = Convert.ToBoolean(input["write"]);
                        deleting = input.ContainsKey("deleting") && Convert.ToBoolean(input["deleting"]);
                        // Hold out other writers from the revision check through
                        // the final flush; readers can still observe the file.
                        IntPtr handle = OpenScopeDirectory(path, (writable ? 0xC0000000u : 0x80000000u) | (deleting ? 0x10000u : 0u), writable ? 1u : 3u, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
                        Check(handle != new IntPtr(-1), "Open sandbox file");
                        file = new FileStream(new SafeFileHandle(handle, true), writable ? FileAccess.ReadWrite : FileAccess.Read);
                        var metadata = WorkspaceFileStat(file);
                        if (Convert.ToString(metadata["dev"]) + ":" + Convert.ToString(metadata["ino"]) != Convert.ToString(input["identity"])) throw new IOException("workspace_authorization_changed");
                        result = metadata;
                    }
                    else if (operation == "stat" && file != null) result = WorkspaceFileStat(file);
                    else if (operation == "read" && file != null)
                    {
                        WorkspaceFileStat(file);
                        int count = Convert.ToInt32(input["count"]);
                        if (count < 1 || count > 65536) throw new IOException("File protocol budget exceeded.");
                        var bytes = new byte[count]; file.Position = Convert.ToInt64(input["offset"]);
                        int read = file.Read(bytes, 0, count); result = Convert.ToBase64String(bytes, 0, read);
                    }
                    else if ((operation == "truncate" && writable) || (operation == "delete" && deleting))
                    {
                        WorkspaceFileStat(file);
                        if (operation == "delete" && (!input.ContainsKey("sha256") || input["sha256"] == null)) throw new IOException("Deletion requires an observed revision.");
                        if (input.ContainsKey("sha256") && input["sha256"] != null)
                        {
                            file.Position = 0;
                            string digest;
                            using (var hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                            if (digest != Convert.ToString(input["sha256"])) throw new IOException("workspace_revision_conflict");
                        }
                        if (operation == "delete") {
                            // This exact handle excludes other writers/replacements
                            // from the digest check until the deletion commits.
                            var disposition = new WorkspaceFileDisposition { Delete = true };
                            Check(SetWorkspaceFileDisposition(file.SafeFileHandle.DangerousGetHandle(), 4, ref disposition, (uint)Marshal.SizeOf(typeof(WorkspaceFileDisposition))), "Delete checked workspace file");
                        } else { file.SetLength(0); file.Position = 0; }
                    }
                    else if (operation == "write" && writable)
                    {
                        WorkspaceFileStat(file);
                        var bytes = Convert.FromBase64String(Convert.ToString(input["data"]));
                        if (bytes.Length > 65536) throw new IOException("File protocol budget exceeded.");
                        file.Write(bytes, 0, bytes.Length);
                    }
                    else if (operation == "release" && file != null && !writable) { file.Dispose(); file = null; }
                    else if (operation == "close") { if (file != null) { file.Dispose(); file = null; } Console.WriteLine("{\"ok\":true}"); return 0; }
                    else throw new IOException("Invalid file protocol operation.");
                    Console.WriteLine(json.Serialize(new { ok = true, result = result }));
                }
                catch (Exception error)
                {
                    string code = error.Message == "workspace_authorization_changed" || error.Message == "workspace_revision_conflict" ? error.Message :
                        error is FileNotFoundException ? "ENOENT" : error is UnauthorizedAccessException || error is Win32Exception && ((Win32Exception)error).NativeErrorCode == 5 ? "EACCES" : "sandbox_file_io_failed";
                    Console.WriteLine(json.Serialize(new { ok = false, code = code, message = error.Message }));
                    return 1; // A failed operation cannot continue on a possibly different handle.
                }
            }
            return 0;
        }
        finally { if (file != null) file.Dispose(); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct WorkspaceBasicInformation
    {
        public long CreationTime, AccessTime, WriteTime, ChangeTime;
        public uint Attributes;
    }
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    private static extern bool GetWorkspaceBasicInformation(IntPtr handle, int infoClass, out WorkspaceBasicInformation info, uint size);
    [StructLayout(LayoutKind.Sequential)] private struct WorkspaceFileDisposition { [MarshalAs(UnmanagedType.U1)] public bool Delete; }
    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
    private static extern bool SetWorkspaceFileDisposition(IntPtr handle, int infoClass, ref WorkspaceFileDisposition info, uint size);
}
