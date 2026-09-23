// Small prebuilt supervisor: no PowerShell bootstrap, process enumeration, or
// per-output sampling. Memory/CPU/process-count limits are enforced by Windows.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static partial class CardBushProcessHost
{
    private const uint JOB_KILL_ON_CLOSE = 0x2000;
    private const uint JOB_MEMORY_LIMIT = 0x200;
    private const uint JOB_ACTIVE_PROCESS_LIMIT = 0x8;
    private const uint JOB_PRIORITY_CLASS = 0x20;
    private const uint BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
    private const uint FAILURE_EXIT = 0xCA000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private static readonly object FailureLock = new object();
    private static string failureCode = "";
    private static string failureMessage = "";
    private static IntPtr taskJob;
    private static ulong taskMemory;
    private static ulong totalMemory;
    private static ulong peakMemory;
    private static int nativeErrorCode;

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--capabilities")
        {
            Console.WriteLine("{\"protocol\":\"cardbush.process-host.v1\",\"sandboxVersion\":1}");
            return 0;
        }
        if (args.Length == 2 && args[0] == "--observe") return Observe(args[1]);
        if (args.Length == 2 && args[0] == "--sandbox-cleanup") return CleanupSandbox(args[1]);
        string reportPath = args.Length > 9 ? args[9] : null;
        IntPtr globalJob = IntPtr.Zero, completionPort = IntPtr.Zero, parent = IntPtr.Zero;
        EventWaitHandle pressureStop = null;
        MemoryMappedFile pressureState = null;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        uint exitCode = FAILURE_EXIT;
        bool resumed = false;
        bool startingCommand = false;
        SandboxSession sandbox = null;
        bool sandboxCleaned = false;
        var inheritedHandles = new List<IntPtr>();
        try
        {
            if (args.Length < 11) throw new ArgumentException("Missing process resource host arguments.");
            string groupName = args[0];
            int commandStart = args[10] == "--lease" ? 12 : 10;
            string leaseId = commandStart == 12 ? args[11] : null;
            if (leaseId != null && !ValidLease(leaseId)) throw new ArgumentException("Invalid resource lease.");
            if (args.Length > commandStart && args[commandStart] == "--sandbox")
            {
                if (args.Length <= commandStart + 2) throw new ArgumentException("Missing sandbox policy or command.");
                sandbox = new SandboxSession(args[commandStart + 1]);
                commandStart += 2;
            }
            pressureState = MemoryMappedFile.CreateOrOpen(groupName + "-pressure-state", 16);
            if (leaseId != null) pressureStop = new EventWaitHandle(false, EventResetMode.ManualReset, groupName + "-" + leaseId + "-pressure");
            uint parentPid = UInt32.Parse(args[1]);
            taskMemory = UInt64.Parse(args[2]);
            totalMemory = UInt64.Parse(args[3]);
            uint cpuPercent = UInt32.Parse(args[4]);
            uint taskProcesses = UInt32.Parse(args[5]), totalProcesses = UInt32.Parse(args[6]);
            ulong criticalMemory = UInt64.Parse(args[7]), diskReserve = UInt64.Parse(args[8]);
            if (taskMemory == 0 || totalMemory < taskMemory || cpuPercent == 0 || cpuPercent > 100 || taskProcesses == 0 || totalProcesses == 0)
                throw new ArgumentException("Invalid process resource budget.");

            parent = OpenProcess(0x00100000, false, parentPid); // SYNCHRONIZE, pinned handle avoids PID reuse.
            Check(parent != IntPtr.Zero, "Open runtime process");
            // The shared job is configured once. All task launchers in this Runtime
            // attach to it; limits never multiply with sessions or subagents.
            using (var mutex = new Mutex(false, groupName + "-configure"))
            {
                bool locked = false;
                try
                {
                    try { locked = mutex.WaitOne(5000); }
                    catch (AbandonedMutexException) { locked = true; }
                    if (!locked) throw new InvalidOperationException("Resource budget initialization is busy.");
                    globalJob = CreateJobObject(IntPtr.Zero, groupName);
                    int creationError = Marshal.GetLastWin32Error();
                    Check(globalJob != IntPtr.Zero, "Create shared job");
                    if (creationError != 183) // ERROR_ALREADY_EXISTS
                    {
                        SetLimits(globalJob, totalMemory, totalProcesses, true);
                        var cpu = new CPU_LIMIT { ControlFlags = 0x1 | 0x4, CpuRate = cpuPercent * 100 };
                        Check(SetCpuInformation(globalJob, 15, ref cpu, (uint)Marshal.SizeOf(typeof(CPU_LIMIT))), "Set CPU budget");
                    }
                }
                finally { if (locked) mutex.ReleaseMutex(); }
            }
            taskJob = CreateJobObject(IntPtr.Zero, leaseId == null ? null : groupName + "-" + leaseId);
            Check(taskJob != IntPtr.Zero, "Create task job");
            SetLimits(taskJob, taskMemory, taskProcesses, false);

            completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            Check(completionPort != IntPtr.Zero, "Create resource notification port");
            var association = new COMPLETION_PORT { CompletionKey = new IntPtr(1), CompletionPort = completionPort };
            Check(SetCompletionInformation(taskJob, 7, ref association, (uint)Marshal.SizeOf(typeof(COMPLETION_PORT))), "Attach resource notifications");

            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = 0x100; // STARTF_USESTDHANDLES
            startup.hStdInput = InheritStandardHandle(-10, inheritedHandles);
            startup.hStdOutput = InheritStandardHandle(-11, inheritedHandles);
            startup.hStdError = InheritStandardHandle(-12, inheritedHandles);
            var commandLine = new StringBuilder();
            for (int i = commandStart; i < args.Length; i++)
            {
                if (i > commandStart) commandLine.Append(' ');
                commandLine.Append(QuoteArgument(args[i]));
            }
            // No user code executes until BOTH jobs are assigned. Never fall back
            // to running unprotected when a Windows API or budget setup fails.
            startingCommand = true;
            if (sandbox == null)
                Check(CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    0x4 | 0x08000000, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out process), "Create suspended command");
            else
                sandbox.CreateSuspended(commandLine, ref startup, out process);
            startingCommand = false;
            Check(AssignProcessToJobObject(globalJob, process.hProcess), "Assign shared budget");
            Check(AssignProcessToJobObject(taskJob, process.hProcess), "Assign task budget");
            foreach (IntPtr handle in inheritedHandles) CloseHandle(handle);
            inheritedHandles.Clear();

            IntPtr portForThread = completionPort;
            var notifications = new Thread(delegate() { WatchNotifications(portForThread); });
            notifications.IsBackground = true;
            notifications.Start();
            // Check free space only once per watchdog tick, and only on volumes the
            // task starts on. This is a pressure backstop, not a filesystem quota.
            string[] diskPaths = new string[] { Environment.CurrentDirectory, Path.GetTempPath() };
            ulong[] initialFree = new ulong[] { DiskFree(diskPaths[0]), DiskFree(diskPaths[1]) };
            Check(ResumeThread(process.hThread) != UInt32.MaxValue, "Resume protected command");
            resumed = true;
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;

            // Normal commands wake on process exit immediately. The two-second
            // watchdog runs only for live jobs; it never delays short commands.
            IntPtr[] waits = pressureStop == null ? new IntPtr[] { process.hProcess, parent }
                : new IntPtr[] { process.hProcess, parent, pressureStop.SafeWaitHandle.DangerousGetHandle() };
            while (true)
            {
                uint wait = WaitForMultipleObjects((uint)waits.Length, waits, false, 2000);
                if (wait == 0) break;
                if (wait == 2)
                {
                    Fail("resource_memory_pressure", "System memory became critically low. This task was stopped to keep the host responsive. Reduce the workload before retrying.");
                    break;
                }
                if (wait == 1)
                {
                    Fail("resource_parent_exited", "The Runtime exited; its task processes were stopped.");
                    break;
                }
                if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for protected command");
                UpdatePeakMemory();
                var memory = new MEMORYSTATUSEX();
                memory.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
                if (GlobalMemoryStatusEx(ref memory) && Math.Min(memory.ullAvailPhys, memory.ullAvailPageFile) < criticalMemory
                    && CurrentMemory(taskJob) >= 256UL * 1024 * 1024 && ClaimFallbackRelief(groupName, pressureState))
                {
                    Fail("resource_memory_pressure", "System memory became critically low. This task was stopped to keep the host responsive. Reduce the workload before retrying.");
                    break;
                }
                for (int i = 0; i < diskPaths.Length; i++)
                {
                    ulong free = DiskFree(diskPaths[i]);
                    if (free < diskReserve && initialFree[i] > free && initialFree[i] - free > 8UL * 1024 * 1024)
                    {
                        Fail("resource_disk_pressure", "Free disk space became critically low. This task was stopped. Free space or reduce intermediate output before retrying.");
                        break;
                    }
                }
            }
            UpdatePeakMemory();
            Check(GetExitCodeProcess(process.hProcess, out exitCode), "Read command exit status");
        }
        catch (Exception error)
        {
            var nativeError = error as Win32Exception;
            nativeErrorCode = nativeError == null ? 0 : nativeError.NativeErrorCode;
            Fail(startingCommand ? "resource_spawn_failed" : "resource_protection_failed",
                "Process protection could not be established or maintained: " + error.Message);
            // A command can fail before assignment to its task job. It is still
            // suspended, so explicitly terminate this handle as well.
            if (!resumed && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, FAILURE_EXIT);
        }
        finally
        {
            UpdatePeakMemory();
            // Closing the only non-inheritable task job handle also kills detached
            // descendants. It works even if this supervisor is forcibly terminated.
            if (taskJob != IntPtr.Zero)
            {
                TerminateJobObject(taskJob, failureCode.Length > 0 ? FAILURE_EXIT : exitCode);
                CloseHandle(taskJob);
                taskJob = IntPtr.Zero;
            }
            if (process.hProcess != IntPtr.Zero)
            {
                WaitForSingleObject(process.hProcess, 2000);
                CloseHandle(process.hProcess);
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            foreach (IntPtr handle in inheritedHandles) CloseHandle(handle);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (pressureStop != null) pressureStop.Dispose();
            if (pressureState != null) pressureState.Dispose();
            if (globalJob != IntPtr.Zero) CloseHandle(globalJob);
            if (completionPort != IntPtr.Zero) CloseHandle(completionPort);
            if (sandbox != null)
            {
                try { sandbox.Dispose(); sandboxCleaned = true; }
                catch (Exception error) { Fail("sandbox_cleanup_failed", "Sandbox cleanup failed: " + error.Message); }
            }
            if (reportPath != null)
            {
                try
                {
                    string report = "{\"phase\":\"finished\",\"code\":" + JsonString(failureCode)
                        + ",\"message\":" + JsonString(failureMessage) + ",\"peakMemoryBytes\":" + peakMemory
                        + ",\"taskMemoryBytes\":" + taskMemory + ",\"totalMemoryBytes\":" + totalMemory
                        + ",\"nativeErrorCode\":" + nativeErrorCode + ",\"sandboxCleaned\":" + (sandboxCleaned ? "true" : "false") + "}";
                    File.WriteAllText(reportPath, report, new UTF8Encoding(false));
                }
                catch { exitCode = FAILURE_EXIT; }
            }
        }
        return unchecked((int)(failureCode.Length > 0 ? FAILURE_EXIT : exitCode));
    }

    // An ephemeral shared watchdog clock prevents a monitor failure from either
    // disabling protection or making every service terminate at the same time.
    private static bool ClaimFallbackRelief(string group, MemoryMappedFile state)
    {
        using (var mutex = new Mutex(false, group + "-pressure-lock"))
        {
            bool locked = false;
            try
            {
                try { locked = mutex.WaitOne(0); } catch (AbandonedMutexException) { locked = true; }
                if (!locked) return false;
                using (var view = state.CreateViewAccessor())
                {
                    long now = DateTime.UtcNow.Ticks;
                    if (now - view.ReadInt64(0) < TimeSpan.TicksPerSecond * 6 || now - view.ReadInt64(8) < TimeSpan.TicksPerSecond * 6) return false;
                    view.Write(8, now);
                    return true;
                }
            }
            finally { if (locked) mutex.ReleaseMutex(); }
        }
    }

    private static bool ValidLease(string id) { Guid parsed; return Guid.TryParseExact(id, "D", out parsed); }

    private static ulong CurrentMemory(IntPtr job)
    {
        MEMORY_USAGE usage;
        Check(QueryMemoryInformation(job, 28, out usage, (uint)Marshal.SizeOf(typeof(MEMORY_USAGE)), IntPtr.Zero), "Query job memory");
        return usage.JobMemory;
    }

    private static int Observe(string group)
    {
        if (!group.StartsWith("Local\\CardBush-Tasks-", StringComparison.Ordinal) || group.Length > 160) return 1;
        try
        {
            using (var state = MemoryMappedFile.CreateOrOpen(group + "-pressure-state", 16))
            using (var view = state.CreateViewAccessor())
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    if (line.Length > 16384) return 1;
                    string[] parts = line.Split('\t');
                    if (parts.Length != 2) return 1;
                    if (parts[0] == "relieve" && ValidLease(parts[1]))
                    {
                        try
                        {
                            using (var stop = EventWaitHandle.OpenExisting(group + "-" + parts[1] + "-pressure"))
                            { view.Write(8, DateTime.UtcNow.Ticks); stop.Set(); }
                        }
                        catch (WaitHandleCannotBeOpenedException) { }
                        continue;
                    }
                    if (parts[0] != "sample") return 1;
                    var jobs = new StringBuilder();
                    string[] ids = parts[1].Split(',');
                    if (ids.Length > 256) return 1;
                    foreach (string id in ids)
                    {
                        if (!ValidLease(id)) return 1;
                        IntPtr job = OpenJobObject(0x4, false, group + "-" + id);
                        if (job == IntPtr.Zero) continue;
                        try
                        {
                            if (jobs.Length > 0) jobs.Append(',');
                            jobs.Append("{\"id\":").Append(JsonString(id)).Append(",\"memoryBytes\":").Append(CurrentMemory(job)).Append('}');
                        }
                        finally { CloseHandle(job); }
                    }
                    ulong total = 0;
                    IntPtr global = OpenJobObject(0x4, false, group);
                    if (global != IntPtr.Zero) { try { total = CurrentMemory(global); } finally { CloseHandle(global); } }
                    var memory = new MEMORYSTATUSEX(); memory.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
                    Check(GlobalMemoryStatusEx(ref memory), "Query system memory");
                    view.Write(0, DateTime.UtcNow.Ticks);
                    Console.WriteLine("{\"availableMemoryBytes\":" + memory.ullAvailPhys + ",\"availableCommitBytes\":" + memory.ullAvailPageFile
                        + ",\"totalMemoryBytes\":" + total + ",\"jobs\":[" + jobs + "]}");
                    Console.Out.Flush();
                }
            }
            return 0;
        }
        catch { return 1; }
    }

    private static void SetLimits(IntPtr job, ulong memory, uint processes, bool shared)
    {
        var limits = new EXTENDED_LIMIT();
        limits.BasicLimitInformation.LimitFlags = JOB_KILL_ON_CLOSE | JOB_MEMORY_LIMIT | JOB_ACTIVE_PROCESS_LIMIT;
        limits.BasicLimitInformation.ActiveProcessLimit = processes;
        if (shared)
        {
            limits.BasicLimitInformation.LimitFlags |= JOB_PRIORITY_CLASS;
            limits.BasicLimitInformation.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS;
        }
        limits.JobMemoryLimit = new UIntPtr(memory);
        Check(SetExtendedInformation(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "Set process/memory budget");
    }

    private static void WatchNotifications(IntPtr port)
    {
        while (true)
        {
            uint message;
            UIntPtr key;
            IntPtr process;
            if (!GetQueuedCompletionStatus(port, out message, out key, out process, INFINITE)) return;
            if (message == 9 || message == 10)
                Fail("resource_memory_limit", "This task reached its memory budget. Use streaming, fewer columns, or disk-backed processing before retrying; do not raise or bypass the host budget.");
            else if (message == 3)
                Fail("resource_process_limit", "This task reached its child-process budget. Reduce worker concurrency before retrying.");
        }
    }

    private static void Fail(string code, string message)
    {
        lock (FailureLock)
        {
            if (failureCode.Length != 0) return;
            failureCode = code;
            failureMessage = message;
            if (taskJob != IntPtr.Zero) TerminateJobObject(taskJob, FAILURE_EXIT);
        }
    }

    private static void UpdatePeakMemory()
    {
        if (taskJob == IntPtr.Zero) return;
        EXTENDED_LIMIT limits;
        if (QueryExtendedInformation(taskJob, 9, out limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)), IntPtr.Zero))
            peakMemory = Math.Max(peakMemory, limits.PeakJobMemoryUsed.ToUInt64());
    }

    private static ulong DiskFree(string path)
    {
        ulong available, total, free;
        return GetDiskFreeSpaceEx(path, out available, out total, out free) ? available : UInt64.MaxValue;
    }

    private static IntPtr InheritStandardHandle(int id, List<IntPtr> handles)
    {
        IntPtr duplicate;
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(), out duplicate, 0, true, 2), "Inherit command stream");
        handles.Add(duplicate);
        return duplicate;
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char value in argument)
        {
            if (value == '\\') { slashes++; continue; }
            if (value == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            text.Append(value);
            slashes = 0;
        }
        text.Append('\\', slashes * 2);
        return text.Append('"').ToString();
    }

    private static string JsonString(string value)
    {
        var result = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') result.Append('\\').Append(c);
            else if (c < 32) result.Append("\\u").Append(((int)c).ToString("x4"));
            else result.Append(c);
        }
        return result.Append('"').ToString();
    }

    private static void Check(bool succeeded, string operation)
    {
        if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    [StructLayout(LayoutKind.Sequential)] private struct BASIC_LIMIT
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] private struct EXTENDED_LIMIT
    {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] private struct CPU_LIMIT { public uint ControlFlags, CpuRate; }
    [StructLayout(LayoutKind.Sequential)] private struct MEMORY_USAGE { public ulong JobMemory, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct COMPLETION_PORT { public IntPtr CompletionKey, CompletionPort; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MEMORYSTATUSEX
    {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] private static extern bool QueryMemoryInformation(IntPtr job, int kind, out MEMORY_USAGE information, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)] private static extern bool SetExtendedInformation(IntPtr job, int kind, ref EXTENDED_LIMIT information, uint length);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)] private static extern bool SetCpuInformation(IntPtr job, int kind, ref CPU_LIMIT information, uint length);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)] private static extern bool SetCompletionInformation(IntPtr job, int kind, ref COMPLETION_PORT information, uint length);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] private static extern bool QueryExtendedInformation(IntPtr job, int kind, out EXTENDED_LIMIT information, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr overlapped, uint milliseconds);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free);
}
