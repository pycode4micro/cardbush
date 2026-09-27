import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { addComputerUseTimings } from './computerUseTimings.js';

const execFileAsync = promisify(execFile);
const bootstrap = [
  "$ErrorActionPreference = 'Stop'",
  '$cardbushUtf8 = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = $cardbushUtf8',
  '[Console]::OutputEncoding = $cardbushUtf8',
  '$OutputEncoding = $cardbushUtf8',
  "[Console]::Error.WriteLine('CARDBUSH_NATIVE_READY')",
  '& ([ScriptBlock]::Create($cardbushUtf8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))',
].join('\n');
const encodedBootstrap = Buffer.from(bootstrap, 'utf16le').toString('base64');

const actionPrefix = 'CARDBUSH_ACTION_COMPLETED:';
const timingPrefix = 'CARDBUSH_NATIVE_TIMINGS:';

export function computerUsePowerShellParameters(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => {
    if (!/^CARDBUSH_[A-Z0-9_]+$/.test(key)) throw new Error('Invalid Computer Use parameter name.');
    return `$script:${key} = '${value.replaceAll("'", "''")}'`;
  }).join('\n');
}

/** One request owns one short-lived process. The optional ACK handshake releases
 * input control before observation, without starting another PowerShell host. */
export async function runComputerUsePowerShell(script: string, options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  parameters?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
  afterAction?: (acknowledgement: Record<string, unknown>) => Promise<void>;
}): Promise<string> {
  // Script-local values travel through stdin too. Assigning a large payload to
  // $env would still hit Windows' 32K per-environment-variable limit.
  const parameters = computerUsePowerShellParameters(options.parameters ?? {});
  const started = performance.now();
  addComputerUseTimings({ process_count: 1 });
  const execution = execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedBootstrap,
  ], {
    windowsHide: true,
    timeout: options.timeoutMs,
    signal: options.signal,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    cwd: options.cwd,
    env: options.env,
  });
  let acknowledged = false;
  let callbackError: unknown;
  const outputLines = createInterface({ input: execution.child.stdout! });
  outputLines.on('line', (line) => {
    if (!line.startsWith(actionPrefix)) return;
    if (acknowledged || !options.afterAction) { execution.child.kill(); return; }
    acknowledged = true;
    void (async () => {
      try {
        await options.afterAction!(JSON.parse(line.slice(actionPrefix.length)) as Record<string, unknown>);
        if (!execution.child.killed) execution.child.stdin?.end('observe\n');
      } catch (error) { callbackError = error; execution.child.kill(); }
    })();
  });
  const diagnostics = createInterface({ input: execution.child.stderr! });
  diagnostics.on('line', line => {
    if (line === 'CARDBUSH_NATIVE_READY') addComputerUseTimings({ process_start_ms: performance.now() - started });
    if (line.startsWith(timingPrefix)) {
      try { addComputerUseTimings(JSON.parse(line.slice(timingPrefix.length))); } catch { /* Ignore malformed diagnostics. */ }
    }
  });
  const wrapped = `$script:CardBushTimings = [ordered]@{ initialization_ms=0; input_ms=0; screenshot_ms=0; uia_ms=0; settle_ms=0 }
try {
& {
${parameters}
${script}
}
} finally { [Console]::Error.WriteLine('${timingPrefix}' + ($script:CardBushTimings | ConvertTo-Json -Compress)) }`;
  const source = Buffer.from(wrapped, 'utf8').toString('base64') + '\n';
  const input = new Promise<void>((resolve, reject) => {
    const stdin = execution.child.stdin;
    if (!stdin) { execution.child.kill(); reject(new Error('PowerShell input pipe is unavailable.')); return; }
    // A spawn failure, timeout or cancellation may close the pipe during a write.
    // Handle that error as part of the same call instead of emitting it unhandled.
    stdin.once('error', error => { execution.child.kill(); reject(error); });
    const sent = (error?: Error | null) => error ? reject(error) : resolve();
    if (options.afterAction) stdin.write(source, 'utf8', sent);
    else stdin.end(source, 'utf8', sent);
  });
  try {
    const [{ stdout }] = await Promise.all([execution, input]);
    if (callbackError) throw callbackError;
    return stdout.split(/\r?\n/).filter(line => !line.startsWith(actionPrefix)).join('\n');
  } catch (error) {
    if (callbackError) throw callbackError;
    if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
      error.stderr = error.stderr.split(/\r?\n/).filter(line => line !== 'CARDBUSH_NATIVE_READY' && !line.startsWith(timingPrefix)).join('\n');
    }
    throw error;
  } finally { outputLines.close(); diagnostics.close(); }
}
