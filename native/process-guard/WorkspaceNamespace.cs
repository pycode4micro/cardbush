// The host broker creates and publishes exact names. Content stays in the sandbox.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static partial class CardBushProcessHost
{
    private static WorkspaceHandleInformation WorkspaceNamespaceInfo(IntPtr handle)
    {
        WorkspaceHandleInformation info;
        Check(GetWorkspaceHandleInformation(handle, out info), "Inspect atomic write object");
        if ((info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1)
            throw new IOException("workspace_revision_conflict");
        return info;
    }

    private static void CheckWorkspaceNamespaceRevision(WorkspaceHandleInformation info, string identity, string mtimeNs, string size)
    {
        var id = info.VolumeSerial.ToString() + ":" + (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString();
        long writeTime = ((long)info.WriteTime.dwHighDateTime << 32) | (uint)info.WriteTime.dwLowDateTime;
        ulong length = ((ulong)info.SizeHigh << 32) | info.SizeLow;
        if (id != identity || (mtimeNs != null && ((writeTime - 116444736000000000L).ToString() + "00" != mtimeNs || length.ToString() != size)))
            throw new IOException("workspace_revision_conflict");
    }

    private static void WorkspaceNamespaceOperation(Dictionary<string, string> input, HashSet<string> pinned)
    {
        string stage = input["stage"];
        string parent = Path.GetDirectoryName(stage);
        if (parent == null || !pinned.Contains(parent) || !String.Equals(stage, Path.GetFullPath(stage), StringComparison.OrdinalIgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(stage), @"^\.cardbush-write-[0-9a-f]{32}\.tmp$"))
            throw new IOException("Invalid staging path.");
        if (input["op"] == "stage") {
            var security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            using (var identity = WindowsIdentity.GetCurrent())
                security.AddAccessRule(new FileSystemAccessRule(identity.User, FileSystemRights.FullControl, AccessControlType.Allow));
            using (new FileStream(stage, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, security)) { }
            return;
        }
        string target = input["target"];
        if (input["op"] != "replace" || !String.Equals(Path.GetDirectoryName(target), parent, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(target, Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase) ||
            String.Equals(stage, target, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Invalid replacement path.");
        const uint readMetadata = 0x00020080, delete = 0x00010000, writeDacl = 0x00040000;
        const uint shareReadDelete = 5, openExisting = 3, noReparse = 0x00200000;
        IntPtr source = OpenScopeDirectory(stage, readMetadata | delete | writeDacl, shareReadDelete, IntPtr.Zero, openExisting, noReparse, IntPtr.Zero);
        Check(source != new IntPtr(-1), "Pin atomic write staging file");
        IntPtr destination = new IntPtr(-1);
        try {
            CheckWorkspaceNamespaceRevision(WorkspaceNamespaceInfo(source), input["stageIdentity"], null, null);
            string expected = input["identity"];
            if (expected != null) {
                destination = OpenScopeDirectory(target, readMetadata | 0xC0000000u, shareReadDelete, IntPtr.Zero, openExisting, noReparse, IntPtr.Zero);
                if (destination == new IntPtr(-1) && Marshal.GetLastWin32Error() == 2) throw new IOException("workspace_revision_conflict");
                Check(destination != new IntPtr(-1), "Pin atomic write destination");
                var info = WorkspaceNamespaceInfo(destination);
                CheckWorkspaceNamespaceRevision(info, expected, input["mtimeNs"], input["size"]);
                if ((info.Attributes & 1) != 0) throw new UnauthorizedAccessException("The destination is read-only.");
                WriteSandboxDirectorySecurity(source, ReadSandboxFileSecurity(destination, target), stage);
                CheckWorkspaceNamespaceRevision(WorkspaceNamespaceInfo(destination), expected, input["mtimeNs"], input["size"]);
                CheckWorkspaceNamespaceRevision(WorkspaceNamespaceInfoAtPath(target), expected, input["mtimeNs"], input["size"]);
            }
            CheckWorkspaceNamespaceRevision(WorkspaceNamespaceInfo(source), input["stageIdentity"], null, null);
            var name = Encoding.Unicode.GetBytes(Path.GetFileName(target));
            // A basename and NULL root rename in the source's pinned parent.
            // No reopening the directory with write sharing or following a target link.
            // FILE_RENAME_INFO uses an aligned HANDLE followed by the byte length.
            int handleOffset = IntPtr.Size, lengthOffset = 2 * IntPtr.Size, nameOffset = lengthOffset + 4;
            int size = nameOffset + name.Length + 2;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                Marshal.WriteInt32(buffer, 0, expected == null ? 0 : 3); // replace + POSIX semantics
                Marshal.WriteIntPtr(buffer, handleOffset, IntPtr.Zero);
                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
                Marshal.WriteInt16(buffer, nameOffset + name.Length, 0);
                WorkspaceRenameStatus result;
                int status = NtSetWorkspaceFileInformation(source, out result, buffer, (uint)size, 65); // FileRenameInformationEx
                if (status < 0) {
                    int error = (int)RtlWorkspaceStatusToDosError(status);
                    if (expected == null && (error == 80 || error == 183)) throw new IOException("workspace_revision_conflict");
                    throw new System.ComponentModel.Win32Exception(error, "Atomic workspace file replacement: " + new System.ComponentModel.Win32Exception(error).Message);
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally {
            if (destination != new IntPtr(-1)) CloseHandle(destination);
            CloseHandle(source);
        }
    }

    private static WorkspaceHandleInformation WorkspaceNamespaceInfoAtPath(string path)
    {
        IntPtr handle = OpenScopeDirectory(path, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (handle == new IntPtr(-1) && Marshal.GetLastWin32Error() == 2) throw new IOException("workspace_revision_conflict");
        Check(handle != new IntPtr(-1), "Inspect atomic write destination name");
        try { return WorkspaceNamespaceInfo(handle); }
        finally { CloseHandle(handle); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WorkspaceRenameStatus { public IntPtr Status, Information; }
    [DllImport("ntdll.dll", EntryPoint = "NtSetInformationFile")]
    private static extern int NtSetWorkspaceFileInformation(IntPtr handle, out WorkspaceRenameStatus status, IntPtr info, uint size, int infoClass);
    [DllImport("ntdll.dll", EntryPoint = "RtlNtStatusToDosError")]
    private static extern uint RtlWorkspaceStatusToDosError(int status);
}
