import { execFileSync } from 'node:child_process';
import path from 'node:path';

const port = process.env.CARDBUSH_ELECTRON_DEV_PORT ?? '5173';
const projectRoot = path.resolve(import.meta.dirname, '..').toLowerCase();

if (process.platform !== 'win32') {
  process.exit(0);
}

const script = `
$port = ${JSON.stringify(port)}
$projectRoot = ${JSON.stringify(projectRoot)}
$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($connection in $connections) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
  if ($null -eq $process) { continue }
  $command = ($process.CommandLine ?? '').ToLowerInvariant()
  if ($command.Contains($projectRoot) -and ($command.Contains('vite') -or $command.Contains('node'))) {
    Stop-Process -Id $connection.OwningProcess -Force
  }
}
`;

try {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
} catch {
  // Best-effort cleanup. Vite will still report a clear port error if cleanup fails.
}
