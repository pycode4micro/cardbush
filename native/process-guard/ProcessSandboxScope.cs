// Reusable, host-owned directory authorization. Commands keep one-use package
// identities; only an exact, already-admitted filesystem capability is shared.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class CardBushProcessHost
{
    private static readonly Dictionary<string, IntPtr> PinnedSandboxDirectories = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, IntPtr> SandboxAclHandles = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
    private sealed class SandboxScopeReference
    {
        public string policyPath { get; set; }
        public int processId { get; set; }
    }
    private sealed class SandboxScopePolicy
    {
        public int version { get; set; }
        public int ownerPid { get; set; }
        public string capability { get; set; }
        public string[] readableRoots { get; set; }
        public string[] writableRoots { get; set; }
        public Dictionary<string, string> expectedIdentities { get; set; }
    }

    private static SandboxScopePolicy ReadSandboxScope(string path, bool cleanup)
    {
        if (new FileInfo(path).Length > 65536) throw new ArgumentException("Sandbox authorization policy is too large.");
        var policy = new JavaScriptSerializer().Deserialize<SandboxScopePolicy>(File.ReadAllText(path));
        if (policy == null || policy.version != 1 || policy.ownerPid <= 0 || policy.capability == null ||
            !System.Text.RegularExpressions.Regex.IsMatch(policy.capability, @"\ACardBush\.Scope\.[a-f0-9]{32}\z") ||
            policy.readableRoots == null || policy.writableRoots == null || policy.readableRoots.Length + policy.writableRoots.Length > 64)
            throw new ArgumentException("Invalid sandbox authorization policy.");
        foreach (string root in policy.readableRoots) ValidateSandboxDirectory(root, cleanup);
        foreach (string root in policy.writableRoots) ValidateSandboxDirectory(root, cleanup);
        return policy;
    }

    private static SecurityIdentifier ScopeCapability(string name)
    {
        IntPtr groups = IntPtr.Zero, capabilities = IntPtr.Zero;
        uint groupCount = 0, capabilityCount = 0;
        try
        {
            Check(DeriveCapabilitySidsFromName(name, out groups, out groupCount, out capabilities, out capabilityCount), "Derive directory capability");
            if (capabilityCount != 1) throw new ArgumentException("Unexpected directory capability count.");
            return new SecurityIdentifier(Marshal.ReadIntPtr(capabilities));
        }
        finally
        {
            FreeCapabilityArray(groups, groupCount);
            FreeCapabilityArray(capabilities, capabilityCount);
        }
    }

    // All hosts for this account participate, including one-use sandboxes. A
    // file moved during broader authorization can retain an inherited ACE. Never
    // issue the old cached capability to a new command after such a scope switch.
    private static Microsoft.Win32.RegistryKey OpenScopeGeneration()
    {
        // HKCU is shared by this account across Windows sessions. Unlike a
        // Global memory mapping, it needs no SeCreateGlobalPrivilege. Commands
        // receive no registry grant; this stores only an epoch and scope digest.
        return Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\CardBush\SandboxScopeGeneration", Microsoft.Win32.RegistryKeyPermissionCheck.ReadWriteSubTree);
    }

    private static string ScopeFingerprint(string[] read, string[] write)
    {
        var parts = new System.Collections.Generic.List<string>();
        foreach (string path in read) parts.Add("r:" + path.ToLowerInvariant());
        foreach (string path in write) parts.Add("w:" + path.ToLowerInvariant());
        parts.Sort(StringComparer.Ordinal);
        byte[] digest;
        using (var hash = System.Security.Cryptography.SHA256.Create()) digest = hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(String.Join("\0", parts.ToArray())));
        return BitConverter.ToString(digest).Replace("-", "");
    }

    private static long SelectScopeGeneration(Microsoft.Win32.RegistryKey state, string[] read, string[] write)
    {
        string fingerprint = ScopeFingerprint(read, write);
        long generation = 0;
        WithSandboxAclLock(delegate {
            string[] previous = Convert.ToString(state.GetValue("State", "")).Split('|');
            bool matches = previous.Length == 2 && Int64.TryParse(previous[0], out generation) && generation > 0 && previous[1] == fingerprint;
            if (!matches)
            {
                generation++;
                state.SetValue("State", generation + "|" + fingerprint, Microsoft.Win32.RegistryValueKind.String);
            }
        });
        return generation;
    }

    // A broader writer can move a file AFTER a narrower cache was created. An
    // epoch at startup alone cannot detect that ordering. Record live namespace
    // writers under the same cross-process ACL lock used to issue tokens.
    private static string ScopeWriterName()
    {
        return "Writer." + System.Diagnostics.Process.GetCurrentProcess().Id;
    }

    private static bool HasConflictingScopeWriter(Microsoft.Win32.RegistryKey state, string[] read, string[] write)
    {
        string fingerprint = ScopeFingerprint(read, write);
        bool conflict = false;
        foreach (string name in state.GetValueNames())
        {
            if (!name.StartsWith("Writer.", StringComparison.Ordinal)) continue;
            uint pid;
            bool dead = false;
            if (!UInt32.TryParse(name.Substring(7), out pid)) { conflict = true; continue; }
            IntPtr process = OpenProcess(0x00100000, false, pid);
            if (process != IntPtr.Zero)
            {
                try { dead = WaitForSingleObject(process, 0) == 0; }
                finally { CloseHandle(process); }
            }
            else dead = Marshal.GetLastWin32Error() == 87; // No such PID; access denied is NOT proof of exit.
            if (dead)
            {
                state.DeleteValue(name, false);
                // Caches created during a crashed writer are also invalid.
                state.SetValue("State", (ReadScopeGeneration(state) + 1) + "|retired-writer", Microsoft.Win32.RegistryValueKind.String);
            }
            else if (Convert.ToString(state.GetValue(name, "")) != fingerprint) conflict = true;
        }
        return conflict;
    }

    private static void BeginScopeWriter(Microsoft.Win32.RegistryKey state, string[] read, string[] write)
    {
        state.SetValue(ScopeWriterName(), ScopeFingerprint(read, write), Microsoft.Win32.RegistryValueKind.String);
        SelectScopeGeneration(state, read, write);
    }

    private static void EndScopeWriter(Microsoft.Win32.RegistryKey state, string[] read, string[] write)
    {
        WithSandboxAclLock(delegate {
            // Invalidate narrower caches created while this writer was alive.
            SelectScopeGeneration(state, read, write);
            state.DeleteValue(ScopeWriterName(), false);
        });
    }

    private static long ReadScopeGeneration(Microsoft.Win32.RegistryKey state)
    {
        long generation;
        return Int64.TryParse(Convert.ToString(state.GetValue("State", "")).Split('|')[0], out generation) ? generation : 0;
    }

    private static void FreeCapabilityArray(IntPtr array, uint count)
    {
        if (array == IntPtr.Zero) return;
        for (int i = 0; i < count; i++) LocalFree(Marshal.ReadIntPtr(array, i * IntPtr.Size));
        LocalFree(array);
    }

    private static void RevokeScope(SandboxScopePolicy policy, SecurityIdentifier identity)
    {
        Exception failure = null;
        foreach (string root in policy.readableRoots)
            try { RevokeSandboxDirectory(root, identity); } catch (Exception error) { failure = failure ?? error; }
        foreach (string root in policy.writableRoots)
            try { RevokeSandboxDirectory(root, identity); } catch (Exception error) { failure = failure ?? error; }
        if (failure != null) throw failure;
    }

    private static int RunSandboxScope(string file)
    {
        SandboxScopePolicy policy = null;
        SecurityIdentifier identity = null;
        IntPtr owner = IntPtr.Zero;
        var pinnedDirectories = new System.Collections.Generic.List<IntPtr>();
        Microsoft.Win32.RegistryKey generationState = null;
        bool cleaned = false;
        int result = 0;
        try
        {
            policy = ReadSandboxScope(file, false);
            owner = OpenProcess(0x00100000, false, (uint)policy.ownerPid);
            Check(owner != IntPtr.Zero, "Pin authorization owner");
            identity = ScopeCapability(policy.capability);
            generationState = OpenScopeGeneration();
            long generation = SelectScopeGeneration(generationState, policy.readableRoots, policy.writableRoots);
            // Keep granted paths stable until revocation. These host-only
            // metadata handles grant the sandbox no parent-directory access.
            // Pin ancestors as well so moving a parent cannot strand an ACL.
            var pinnedPaths = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string root in policy.readableRoots) PinScopePath(root, pinnedPaths, pinnedDirectories);
            foreach (string root in policy.writableRoots) PinScopePath(root, pinnedPaths, pinnedDirectories);
            foreach (string root in policy.readableRoots) CheckSandboxIdentity(root, policy.expectedIdentities);
            foreach (string root in policy.writableRoots) CheckSandboxIdentity(root, policy.expectedIdentities);
            foreach (string root in policy.readableRoots) GrantSandboxDirectory(root, identity, FileSystemRights.ReadAndExecute);
            foreach (string root in policy.writableRoots) GrantSandboxDirectory(root, identity, FileSystemRights.Modify);
            if (WaitForSingleObject(owner, 0) != 258) throw new Exception("Authorization owner exited during setup.");
            // The marker is outside every granted root. A command pins this
            // supervisor's process before accepting its PID-bound ready marker.
            File.WriteAllText(file + ".ready", System.Diagnostics.Process.GetCurrentProcess().Id.ToString() + "\n" + generation);
            using (var stop = new ManualResetEvent(false))
            {
                var input = new Thread(delegate() { try { Console.ReadLine(); } catch { } finally { try { stop.Set(); } catch (ObjectDisposedException) { } } });
                input.IsBackground = true; input.Start();
                WaitForMultipleObjects(2, new IntPtr[] { owner, stop.SafeWaitHandle.DangerousGetHandle() }, false, INFINITE);
            }
        }
        catch (Exception error) { Console.Error.WriteLine("Sandbox authorization failed: " + error.Message); result = 1; }
        finally
        {
            try { File.Delete(file + ".ready"); } catch { }
            try { if (policy != null && identity != null) RevokeScope(policy, identity); cleaned = true; }
            catch (Exception error) { Console.Error.WriteLine("Sandbox authorization cleanup failed: " + error.Message); result = 1; }
            foreach (IntPtr directory in pinnedDirectories) CloseHandle(directory);
            CloseSandboxAclHandles();
            if (owner != IntPtr.Zero) CloseHandle(owner);
            if (generationState != null) generationState.Dispose();
            try { File.WriteAllText(file + ".finished", "{\"cleaned\":" + (cleaned ? "true" : "false") + "}"); } catch { }
        }
        return result;
    }

    private static void PinScopePath(string root, System.Collections.Generic.HashSet<string> paths, System.Collections.Generic.List<IntPtr> handles)
    {
        var pending = new Stack<string>();
        for (string path = root; path != null && !paths.Contains(path); path = Path.GetDirectoryName(path)) pending.Push(path);
        while (pending.Count > 0)
        {
            string path = pending.Pop();
            IntPtr handle = OpenScopeDirectory(path, 0x00100081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            Check(handle != new IntPtr(-1), "Pin sandbox directory identity");
            handles.Add(handle);
            WorkspaceHandleInformation info;
            Check(GetWorkspaceHandleInformation(handle, out info), "Inspect sandbox directory identity");
            if ((info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0) throw new IOException("Sandbox directory changed.");
            paths.Add(path);
            PinnedSandboxDirectories[path] = handle;
        }
    }

    private static int CleanupSandboxScope(string file)
    {
        try
        {
            var policy = ReadSandboxScope(file, true);
            RevokeScope(policy, ScopeCapability(policy.capability));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Sandbox authorization cleanup failed: " + error.Message); return 1; }
        finally { CloseSandboxAclHandles(); }
    }

    private static bool SameScope(string[] left, string[] right)
    {
        return new System.Collections.Generic.HashSet<string>(left, StringComparer.OrdinalIgnoreCase).SetEquals(right);
    }

    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint capabilityCount);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenScopeDirectory(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
