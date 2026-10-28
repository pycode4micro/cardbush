// Exact-file grants. No directory enumeration, sibling access, creation or
// deletion rights are conferred by granting an existing file object.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

internal static partial class CardBushProcessHost
{
    // ACL inheritance operates on file objects, including every hard-link
    // alias. Keep names pinned while checking and propagating a directory ACL.
    private sealed class SandboxTreeGuard : IDisposable
    {
        private readonly List<IntPtr> handles = new List<IntPtr>();
        public SandboxTreeGuard(string root)
        {
            try {
                var pending = new Stack<string>(); pending.Push(root);
                while (pending.Count > 0) {
                    string path = pending.Pop();
                    IntPtr handle = OpenScopeDirectory(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    Check(handle != new IntPtr(-1), "Pin sandbox tree entry");
                    handles.Add(handle);
                    WorkspaceHandleInformation info;
                    Check(GetWorkspaceHandleInformation(handle, out info), "Inspect sandbox tree entry");
                    if ((info.Attributes & 0x400) != 0) continue;
                    if ((info.Attributes & 0x10) != 0) {
                        foreach (string child in Directory.EnumerateFileSystemEntries(path)) pending.Push(child);
                    } else if (info.Links != 1) throw new IOException("Sandbox access cannot include a file with multiple hard links.");
                }
            } catch { Dispose(); throw; }
        }
        public void Dispose() { foreach (IntPtr handle in handles) CloseHandle(handle); handles.Clear(); }
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct WorkspaceStandardInformation {
        public long AllocationSize, EndOfFile;
        public uint NumberOfLinks;
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.U1)] public bool DeletePending;
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.U1)] public bool Directory;
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    private static extern bool GetWorkspaceStandardInformation(IntPtr handle, int kind, out WorkspaceStandardInformation info, uint size);
    private static bool WorkspaceDeletePending(IntPtr handle) {
        WorkspaceStandardInformation info;
        Check(GetWorkspaceStandardInformation(handle, 1, out info, (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(WorkspaceStandardInformation))), "Inspect checked deletion");
        return info.DeletePending;
    }
    private static void ValidateSandboxFile(string path, bool cleanup)
    {
        if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) || path.StartsWith(@"\\") ||
            !String.Equals(path, Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase) ||
            (!cleanup && !File.Exists(path)) || Directory.Exists(path) ||
            (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0))
            throw new ArgumentException("Sandbox file grants require canonical regular local files.");
    }

    private static void GrantPinnedSandboxFile(string path, SecurityIdentifier identity, bool write,
        HashSet<string> parents, List<IntPtr> parentHandles, List<IntPtr> files, Dictionary<string, string> expected, bool deleting)
    {
        var ancestors = new Stack<string>();
        for (string current = Path.GetDirectoryName(path); current != null && !parents.Contains(current); current = Path.GetDirectoryName(current))
            ancestors.Push(current);
        while (ancestors.Count > 0)
        {
            string current = ancestors.Pop();
            IntPtr directory = OpenScopeDirectory(current, 0x00100081, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            Check(directory != new IntPtr(-1), "Pin exact-file parent");
            parentHandles.Add(directory);
            WorkspaceHandleInformation info;
            Check(GetWorkspaceHandleInformation(directory, out info), "Inspect exact-file parent");
            if ((info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0) throw new IOException("Sandbox parent changed.");
            parents.Add(current);
        }
        IntPtr handle = OpenScopeDirectory(path, 0x00020080, deleting ? 7u : 3u, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "Pin sandbox file identity");
        files.Add(handle);
        WorkspaceHandleInformation file;
        Check(GetWorkspaceHandleInformation(handle, out file), "Inspect sandbox file");
        CheckSandboxIdentity(path, expected, file);
        // Neither content nor ACL grants may escape through another hard link.
        if ((file.Attributes & (0x10 | 0x400)) != 0 || file.Links != 1)
            throw new IOException("Sandbox file is redirected, special, or has multiple writable aliases.");
        WithSandboxAclLock(delegate {
            var security = ReadSandboxFileSecurity(handle);
            var rights = write ? FileSystemRights.Read | FileSystemRights.Write : FileSystemRights.ReadAndExecute;
            if (deleting) rights |= FileSystemRights.Delete;
            // Installed helpers may live in protected Program Files. If Windows
            // already grants application packages these rights, do not require
            // permission to edit a system-managed DACL merely to execute them.
            FileSystemRights publicRights = 0;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.IdentityReference.Value == "S-1-15-2-1" && rule.AccessControlType == AccessControlType.Allow) publicRights |= rule.FileSystemRights;
            if ((publicRights & rights) == rights) return;
            IntPtr acl = SandboxFileAclHandle(path, file, deleting);
            security = ReadSandboxFileSecurity(acl);
            security.AddAccessRule(new FileSystemAccessRule(identity, rights, AccessControlType.Allow));
            WriteSandboxDirectorySecurity(acl, security);
        });
    }

    private static void CheckSandboxIdentity(string path, Dictionary<string, string> expected)
    {
        IntPtr handle = OpenScopeDirectory(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "Inspect sandbox root identity");
        try {
            WorkspaceHandleInformation info;
            Check(GetWorkspaceHandleInformation(handle, out info), "Inspect sandbox root");
            CheckSandboxIdentity(path, expected, info);
        } finally { CloseHandle(handle); }
    }

    private static void CheckSandboxIdentity(string path, Dictionary<string, string> expected, WorkspaceHandleInformation info)
    {
        string identity;
        if ((info.Attributes & 0x400) != 0 || expected != null && expected.TryGetValue(path, out identity) &&
            identity != info.VolumeSerial.ToString() + ":" + (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString())
            throw new IOException("An authorized sandbox object changed before startup.");
    }

    private static void RevokeSandboxFile(string path, SecurityIdentifier identity)
    {
        WithSandboxAclLock(delegate {
            IntPtr handle;
            bool temporary = !SandboxAclHandles.TryGetValue(path, out handle);
            if (temporary) {
                if (!File.Exists(path)) return;
                handle = OpenScopeDirectory(path, 0x00020080, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
                Check(handle != new IntPtr(-1), "Open sandbox file ACL for cleanup");
            }
            try {
                WorkspaceHandleInformation file;
                Check(GetWorkspaceHandleInformation(handle, out file), "Inspect sandbox cleanup object");
                if ((file.Attributes & (0x10 | 0x400)) != 0) throw new IOException("Sandbox cleanup file redirected.");
                if (WorkspaceDeletePending(handle)) return; // Its ACL dies with the deleted object.
                var security = ReadSandboxFileSecurity(handle);
                bool present = false;
                foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                    if (rule.IdentityReference.Equals(identity)) { present = true; break; }
                if (present) {
                    IntPtr acl = temporary ? SandboxFileAclHandle(path, file, true) : handle;
                    security.PurgeAccessRules(identity);
                    WriteSandboxDirectorySecurity(acl, security);
                }
            } finally { if (temporary) CloseHandle(handle); }
        });
    }

    private static FileSecurity ReadSandboxFileSecurity(IntPtr handle)
    {
        var security = new FileSecurity();
        security.SetSecurityDescriptorBinaryForm(ReadSandboxSecurityDescriptor(handle), AccessControlSections.Access);
        return security;
    }

    private static IntPtr SandboxFileAclHandle(string path, WorkspaceHandleInformation expected, bool deleting)
    {
        IntPtr handle;
        if (SandboxAclHandles.TryGetValue(path, out handle)) return handle;
        handle = OpenScopeDirectory(path, 0x00060080, deleting ? 7u : 3u, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        Check(handle != new IntPtr(-1), "Open pinned file ACL");
        try {
            WorkspaceHandleInformation actual;
            Check(GetWorkspaceHandleInformation(handle, out actual), "Inspect file ACL object");
            if ((actual.Attributes & (0x10 | 0x400)) != 0 || actual.VolumeSerial != expected.VolumeSerial ||
                actual.IndexHigh != expected.IndexHigh || actual.IndexLow != expected.IndexLow)
                throw new IOException("Sandbox file changed before ACL setup.");
            SandboxAclHandles[path] = handle;
            return handle;
        } catch { CloseHandle(handle); throw; }
    }
}
