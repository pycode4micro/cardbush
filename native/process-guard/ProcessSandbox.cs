// Windows command sandbox. AppContainer enforces the access boundary; the
// supervisor and its Job Objects stay outside and own process-tree cleanup.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class CardBushProcessHost
{
    private sealed class SandboxPolicy
    {
        public int version { get; set; }
        public string identity { get; set; }
        public string privateRoot { get; set; }
        public string[] readableRoots { get; set; }
        public string[] writableRoots { get; set; }
        public string network { get; set; }
        public SandboxScopeReference scope { get; set; }
    }

    private static SandboxPolicy ReadSandboxPolicy(string file, bool cleanup = false)
    {
        var bytes = new FileInfo(file);
        if (bytes.Length > 65536) throw new ArgumentException("Sandbox policy is too large.");
        var policy = new JavaScriptSerializer().Deserialize<SandboxPolicy>(File.ReadAllText(file));
        if (policy == null || policy.version != 1 || policy.identity == null ||
            !System.Text.RegularExpressions.Regex.IsMatch(policy.identity, @"\ACardBush\.Task\.[a-f0-9]{32}\z") ||
            (policy.network != "disabled" && policy.network != "enabled") ||
            policy.readableRoots == null || policy.writableRoots == null ||
            policy.readableRoots.Length + policy.writableRoots.Length > 64)
            throw new ArgumentException("Invalid sandbox policy.");
        ValidateSandboxDirectory(policy.privateRoot, cleanup);
        foreach (string path in policy.readableRoots) ValidateSandboxDirectory(path, cleanup);
        foreach (string path in policy.writableRoots) ValidateSandboxDirectory(path, cleanup);
        return policy;
    }

    private static void ValidateSandboxDirectory(string path, bool cleanup)
    {
        if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) ||
            !String.Equals(path.TrimEnd('\\'), Path.GetFullPath(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
            String.Equals(Path.GetPathRoot(path).TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith(@"\\") || (!cleanup && !Directory.Exists(path)) ||
            (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0))
            throw new ArgumentException("Sandbox roots must be existing canonical local directories, not volume roots or reparse points.");
    }

    private sealed class SandboxSession : IDisposable
    {
        private readonly SandboxPolicy policy;
        private IntPtr sid;
        private bool profileCreated;
        private SecurityIdentifier directoryCapability;
        private Microsoft.Win32.RegistryKey generationState;
        private long directoryGeneration;
        public IntPtr ScopeProcess { get; private set; }
        public bool ScopeWasStale { get; private set; }

        public SandboxSession(string file)
        {
            policy = ReadSandboxPolicy(file);
            try
            {
                int hr = CreateAppContainerProfile(policy.identity, "CardBush task", "CardBush isolated command", IntPtr.Zero, 0, out sid);
                // Identities are one-use. Never attach to an existing container.
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                profileCreated = true;
                var identity = new SecurityIdentifier(sid);
                generationState = OpenScopeGeneration();
                if (policy.scope == null)
                {
                    SelectScopeGeneration(generationState, policy.readableRoots, policy.writableRoots);
                    foreach (string path in policy.readableRoots) GrantSandboxDirectory(path, identity, FileSystemRights.ReadAndExecute);
                    foreach (string path in policy.writableRoots) GrantSandboxDirectory(path, identity, FileSystemRights.Modify);
                }
                else
                {
                    var scope = ReadSandboxScope(policy.scope.policyPath, false);
                    if (!SameScope(scope.readableRoots, policy.readableRoots) || !SameScope(scope.writableRoots, policy.writableRoots))
                        throw new ArgumentException("Sandbox authorization does not match the admitted directories.");
                    ScopeProcess = OpenProcess(0x00100000, false, (uint)policy.scope.processId);
                    Check(ScopeProcess != IntPtr.Zero, "Pin directory authorization supervisor");
                    DateTime deadline = DateTime.UtcNow.AddMinutes(2);
                    while (true)
                    {
                        if (WaitForSingleObject(ScopeProcess, 0) != 258) throw new Exception("Directory authorization supervisor exited.");
                        try {
                            string[] ready = File.ReadAllText(policy.scope.policyPath + ".ready").Split('\n');
                            if (ready.Length == 2 && ready[0] == policy.scope.processId.ToString() && Int64.TryParse(ready[1], out directoryGeneration) && directoryGeneration > 0) break;
                        }
                        catch (IOException) { }
                        if (DateTime.UtcNow >= deadline) throw new TimeoutException("Directory authorization setup timed out.");
                        Thread.Sleep(20);
                    }
                    directoryCapability = ScopeCapability(scope.capability);
                }
                GrantSandboxDirectory(policy.privateRoot, identity, FileSystemRights.Modify);
            }
            catch { Dispose(); throw; }
        }

        public void CreateSuspended(StringBuilder command, ref STARTUPINFO startup, out PROCESS_INFORMATION process)
        {
            // Hold the same cross-host lock through token creation. Once created,
            // a command owns its admitted scope; a later switch invalidates reuse.
            STARTUPINFO localStartup = startup;
            PROCESS_INFORMATION localProcess = new PROCESS_INFORMATION();
            WithSandboxAclLock(delegate {
                if (directoryCapability != null && ReadScopeGeneration(generationState) != directoryGeneration)
                {
                    ScopeWasStale = true;
                    directoryCapability = null;
                    SelectScopeGeneration(generationState, policy.readableRoots, policy.writableRoots);
                    var identity = new SecurityIdentifier(sid);
                    foreach (string path in policy.readableRoots) GrantSandboxDirectory(path, identity, FileSystemRights.ReadAndExecute);
                    foreach (string path in policy.writableRoots) GrantSandboxDirectory(path, identity, FileSystemRights.Modify);
                }
                CreateSuspendedCore(command, ref localStartup, out localProcess);
            });
            startup = localStartup;
            process = localProcess;
        }

        private void CreateSuspendedCore(StringBuilder command, ref STARTUPINFO startup, out PROCESS_INFORMATION process)
        {
            var allocations = new List<IntPtr>();
            IntPtr attributes = IntPtr.Zero;
            bool initialized = false;
            try
            {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Measure sandbox attributes");
                attributes = Marshal.AllocHGlobal(size);
                Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "Initialize sandbox attributes");
                initialized = true;
                var capabilities = new SECURITY_CAPABILITIES { AppContainerSid = sid };
                var names = new List<SecurityIdentifier>();
                if (directoryCapability != null) names.Add(directoryCapability);
                if (policy.network == "enabled")
                {
                    // Internet and private-network capability. Windows still excludes
                    // loopback by default; no machine-wide exemption is installed.
                    names.Add(new SecurityIdentifier("S-1-15-3-1"));
                    names.Add(new SecurityIdentifier("S-1-15-3-3"));
                }
                if (names.Count > 0)
                {
                    capabilities.CapabilityCount = (uint)names.Count;
                    int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                    capabilities.Capabilities = Allocate(stride * names.Count, allocations);
                    for (int i = 0; i < names.Count; i++)
                    {
                        var identity = names[i];
                        var binary = new byte[identity.BinaryLength]; identity.GetBinaryForm(binary, 0);
                        IntPtr memory = Allocate(binary.Length, allocations); Marshal.Copy(binary, 0, memory, binary.Length);
                        Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid = memory, Attributes = 4 }, IntPtr.Add(capabilities.Capabilities, stride * i), false);
                    }
                }
                IntPtr caps = Allocate(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), allocations);
                Marshal.StructureToPtr(capabilities, caps, false);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), caps,
                    new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero), "Set AppContainer boundary");
                IntPtr handles = Allocate(IntPtr.Size * 3, allocations);
                Marshal.WriteIntPtr(handles, 0, startup.hStdInput);
                Marshal.WriteIntPtr(handles, IntPtr.Size, startup.hStdOutput);
                Marshal.WriteIntPtr(handles, IntPtr.Size * 2, startup.hStdError);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                    new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Restrict inherited sandbox handles");
                var extended = new STARTUPINFOEX { StartupInfo = startup, AttributeList = attributes };
                extended.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
                Check(CreateSandboxProcess(null, command, IntPtr.Zero, IntPtr.Zero, true,
                    0x4 | 0x08000000 | 0x80000, IntPtr.Zero, Environment.CurrentDirectory, ref extended, out process), "Create suspended AppContainer command");
            }
            finally
            {
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                foreach (IntPtr allocation in allocations) Marshal.FreeHGlobal(allocation);
            }
        }

        public void Dispose()
        {
            Exception failure = null;
            if (profileCreated)
            {
                var identity = new SecurityIdentifier(sid);
                foreach (string path in SandboxRoots(policy))
                {
                    try { RevokeSandboxDirectory(path, identity); }
                    catch (Exception error) { failure = failure ?? error; }
                }
                int hr = DeleteAppContainerProfile(policy.identity);
                if (hr != 0) failure = failure ?? Marshal.GetExceptionForHR(hr);
                profileCreated = false;
            }
            if (sid != IntPtr.Zero) { FreeSid(sid); sid = IntPtr.Zero; }
            if (ScopeProcess != IntPtr.Zero) { CloseHandle(ScopeProcess); ScopeProcess = IntPtr.Zero; }
            if (generationState != null) { generationState.Dispose(); generationState = null; }
            if (failure != null) throw failure;
        }
    }

    private static IntPtr Allocate(int bytes, List<IntPtr> allocations)
    {
        IntPtr result = Marshal.AllocHGlobal(bytes); allocations.Add(result); return result;
    }

    private static IEnumerable<string> SandboxRoots(SandboxPolicy policy)
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in policy.readableRoots) roots.Add(path);
        foreach (string path in policy.writableRoots) roots.Add(path);
        roots.Add(policy.privateRoot);
        return roots;
    }

    private static void GrantSandboxDirectory(string path, SecurityIdentifier identity, FileSystemRights rights)
    {
        WithSandboxAclLock(delegate {
            var security = Directory.GetAccessControl(path, AccessControlSections.Access);
            // The root itself cannot be deleted or renamed by this command.
            security.AddAccessRule(new FileSystemAccessRule(identity, rights & ~FileSystemRights.Delete, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(identity, rights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.InheritOnly, AccessControlType.Allow));
            Directory.SetAccessControl(path, security);
        });
    }

    private static void RevokeSandboxDirectory(string path, SecurityIdentifier identity)
    {
        if (!Directory.Exists(path)) return;
        // Never restore a captured DACL: that would undo another session's grant.
        // Remove only this one-use SID from the current ACL.
        WithSandboxAclLock(delegate {
            var security = Directory.GetAccessControl(path, AccessControlSections.Access);
            bool present = false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                if (rule.IdentityReference.Equals(identity)) { present = true; break; }
            if (!present) return;
            security.PurgeAccessRules(identity);
            Directory.SetAccessControl(path, security);
        });
    }

    private static void WithSandboxAclLock(Action operation)
    {
        // Serialize ACL edits for this account, including nested project roots
        // and hosts running in different Windows sessions. Exact-path locks do
        // not protect against inherited ACL propagation from a parent directory.
        string key = WindowsIdentity.GetCurrent().User.Value;
        using (var mutex = new Mutex(false, "Global\\CardBush-SandboxACL-" + key))
        {
            bool locked = false;
            try
            {
                try { locked = mutex.WaitOne(30000); } catch (AbandonedMutexException) { locked = true; }
                if (!locked) throw new TimeoutException("Sandbox directory authorization is busy.");
                operation();
            }
            finally { if (locked) mutex.ReleaseMutex(); }
        }
    }

    private static int CleanupSandbox(string file)
    {
        IntPtr sid = IntPtr.Zero;
        try
        {
            var policy = ReadSandboxPolicy(file, true);
            int hr = DeriveAppContainerSidFromAppContainerName(policy.identity, out sid);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            var identity = new SecurityIdentifier(sid);
            foreach (string path in SandboxRoots(policy)) RevokeSandboxDirectory(path, identity);
            hr = DeleteAppContainerProfile(policy.identity);
            if (hr != 0 && hr != unchecked((int)0x80070002)) Marshal.ThrowExceptionForHR(hr);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Sandbox cleanup failed: " + error.Message); return 1; }
        finally { if (sid != IntPtr.Zero) FreeSid(sid); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid, Capabilities;
        public uint CapabilityCount, Reserved;
    }
    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr AttributeList; }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateSandboxProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
}
