import { windowsShellPath, type SshPlatform, type SshShell } from '@cardbush/bush-protocol';
import { gzipSync } from 'node:zlib';
import { powerShellCommand } from '@cardbush/platform';

export const posixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const powershellCommand = (script: string) => {
  // Windows sshd may use cmd.exe, whose command line is limited to 8191 chars.
  if (script.length > 2200) {
    const bytes = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
    script = `$bytes=[Convert]::FromBase64String('${bytes}'); $memory=New-Object IO.MemoryStream(,$bytes); $gzip=New-Object IO.Compression.GZipStream($memory,[IO.Compression.CompressionMode]::Decompress); $reader=New-Object IO.StreamReader($gzip,[Text.Encoding]::UTF8); & ([ScriptBlock]::Create($reader.ReadToEnd()))`;
  }
  const command = `pwsh.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  if (command.length > 8100) throw Error('Windows SSH launcher exceeds the shell command line limit.');
  return command;
};

export function remoteShell(platform: SshPlatform, requested?: string): SshShell {
  const shells: SshShell[] = platform === 'windows' ? ['powershell', 'cmd'] : ['posix'];
  const shell = requested || shells[0]!;
  if (!shells.includes(shell as SshShell)) throw Object.assign(
    Error(`SSH host is ${platform}; use shell="${shells[0]}"${shells.length > 1 ? ' or shell="cmd"' : ''}. No user command was sent.`),
    { code: 'ssh_shell_mismatch', details: { platform, supportedShells: shells, defaultShell: shells[0] } });
  return shell as SshShell;
}

export const windowsHostProbe = powershellCommand(
  `if ($PSVersionTable.PSVersion.Major -lt 7 -or [Environment]::OSVersion.Platform -ne 'Win32NT') { exit 1 }; [Console]::WriteLine('CARDBUSH_HOST_WINDOWS_V1'); exit 0`);

// The handle belongs only to the SSH wrapper. Ordinary descendants inherit the
// job, not its handle; wrapper exit closes the last handle and cleans them up.
// This is process ownership, not a sandbox or an elevation mechanism.
const jobSource = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class CardBushSshJob {
  public static string ReadLine() {
    var input = Console.OpenStandardInput();
    var bytes = new System.Collections.Generic.List<byte>();
    int value;
    while ((value = input.ReadByte()) >= 0 && value != 10) {
      if (bytes.Count >= 12 * 1024 * 1024) throw new InvalidOperationException("SSH input exceeds its limit.");
      if (value != 13) bytes.Add((byte)value);
    }
    return value < 0 && bytes.Count == 0 ? null : System.Text.Encoding.UTF8.GetString(bytes.ToArray());
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ROp, WOp, OOp, RBytes, WBytes, OBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr owner;
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Attach(string name) {
    owner = CreateJobObject(IntPtr.Zero, name);
    int error = Marshal.GetLastWin32Error();
    if (owner == IntPtr.Zero) throw new Win32Exception(error);
    if (error == 183) throw new InvalidOperationException("SSH process job already exists.");
    var limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000;
    Check(SetInformationJobObject(owner, 9, ref limits, (uint)Marshal.SizeOf(limits)));
    Check(AssignProcessToJobObject(owner, Process.GetCurrentProcess().Handle));
  }
  public static void Stop(string name) {
    IntPtr job = OpenJobObject(0x0004 | 0x0008, false, name);
    if (job == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 2) return;
      throw new Win32Exception(error);
    }
    try {
      Check(TerminateJobObject(job, 143));
      var timer = Stopwatch.StartNew();
      while (true) {
        Accounting info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (info.ActiveProcesses == 0) return;
        if (timer.ElapsedMilliseconds > 5000) throw new TimeoutException("SSH process job has not stopped.");
        Thread.Sleep(25);
      }
    } finally { CloseHandle(job); }
  }
}`;
const cmdSource = `
public static class CardBushSshCmd {
  public static int Run(string command, string cwd) {
    using (var process = new System.Diagnostics.Process()) {
      var info = process.StartInfo;
      info.FileName = System.Environment.GetEnvironmentVariable("ComSpec");
      info.Arguments = "/d /s /c \\"chcp 65001>nul & " + command + "\\"";
      info.WorkingDirectory = cwd; info.UseShellExecute = false;
      // A hidden console preserves cmd's code page; CREATE_NO_WINDOW makes
      // redirected built-ins fall back to the legacy ANSI code page.
      info.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      process.Start();
      var output = process.StandardOutput.BaseStream.CopyToAsync(System.Console.OpenStandardOutput());
      var error = process.StandardError.BaseStream.CopyToAsync(System.Console.OpenStandardError());
      var input = new System.Threading.Thread(() => {
        try {
          var source = System.Console.OpenStandardInput(); var target = process.StandardInput.BaseStream;
          var buffer = new byte[4096]; int length;
          while ((length = source.Read(buffer, 0, buffer.Length)) > 0) { target.Write(buffer, 0, length); target.Flush(); }
          process.StandardInput.Close();
        }
        catch (System.IO.IOException) {} catch (System.ObjectDisposedException) {} catch (System.InvalidOperationException) {}
      });
      input.IsBackground = true; input.Start();
      process.WaitForExit(); output.GetAwaiter().GetResult(); error.GetAwaiter().GetResult();
      return process.ExitCode;
    }
  }
}`;
const loadJob = `Add-Type -TypeDefinition ${powershellQuote(jobSource)} -ErrorAction Stop`;
const utf8 = `$utf8 = New-Object System.Text.UTF8Encoding $false; [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8`;

export function windowsTerminalCommand(input: { cwd: string; shell: SshShell; job: string; marker: string; startToken: string }): { command: string; prelude: string } {
  const execute = input.shell === 'cmd'
    ? `exit [CardBushSshCmd]::Run($command, $cwd)`
    : `$ErrorActionPreference = 'Continue'; $global:LASTEXITCODE = 0; & ([ScriptBlock]::Create($command)); exit 0`;
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
try {
  ${utf8}
  $cwd = ${powershellQuote(windowsShellPath(input.cwd))}
  Set-Location -LiteralPath $cwd
  [Environment]::CurrentDirectory = $cwd
  Add-Type -TypeDefinition ${powershellQuote(jobSource + (input.shell === 'cmd' ? cmdSource : ''))} -ErrorAction Stop
  [CardBushSshJob]::Attach(${powershellQuote(input.job)})
  [Console]::Error.WriteLine(${powershellQuote(input.marker)} + $PID)
  if ([CardBushSshJob]::ReadLine() -cne ${powershellQuote(input.startToken)}) { exit 125 }
  & "$env:SystemRoot\\System32\\chcp.com" 65001 > $null
  $command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([CardBushSshJob]::ReadLine()))
  ${execute}
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  // Send host code over stdin as well: long Unicode paths must not hit the
  // default Windows SSH shell's command-line limit. The user payload still
  // waits for the ownership marker and a separate start token.
  return {
    command: powershellCommand(`# CARDBUSH_SSH_BOOTSTRAP_V1\n$ProgressPreference='SilentlyContinue'; $prelude=[Console]::ReadLine(); & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($prelude))))`),
    prelude: Buffer.from(script, 'utf8').toString('base64') + '\n',
  };
}

export function windowsTerminalInput(command: string, shell: SshShell, startToken: string): string {
  // Share local PowerShell's status capture, including cmdlet failures and
  // trailing comments. Only the host transport differs.
  const script = shell === 'powershell' ? powerShellCommand(command) : command;
  return startToken + '\n' + Buffer.from(script, 'utf8').toString('base64') + '\n';
}

export function windowsStopCommand(job: string): string {
  return powershellCommand(`$ErrorActionPreference = 'Stop'; try { ${loadJob}; [CardBushSshJob]::Stop(${powershellQuote(job)}); [Console]::WriteLine('CARDBUSH_STOPPED_V1'); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`);
}

export function remoteProgram(platform: SshPlatform, name: string, args: string[], env: Record<string, string> = {}): string {
  if (platform === 'windows') return Object.entries(env).map(([key, value]) => `$env:${key}=${powershellQuote(value)}; `).join('')
    + '& ' + [name, ...args].map(powershellQuote).join(' ');
  return Object.entries(env).map(([key, value]) => `${key}=${posixQuote(value)} `).join('') + [name, ...args].map(posixQuote).join(' ');
}
