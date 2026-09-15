/** Windows launch adapter: preserve SDK command/PATH/.cmd semantics inside the managed Job. */
import { createRequire } from 'node:module';
import type { spawn as nodeSpawn } from 'node:child_process';

const spawn = createRequire(import.meta.url)('cross-spawn') as typeof nodeSpawn;
const [command, ...args] = process.argv.slice(2);
// Only this adapter needs Electron's Node mode. Do not alter the plugin's environment.
const env = { ...process.env };
const originalNodeMode = env.CARDBUSH_MCP_ORIGINAL_NODE_MODE;
delete env.CARDBUSH_MCP_ORIGINAL_NODE_MODE;
if (originalNodeMode === undefined) delete env.ELECTRON_RUN_AS_NODE;
else env.ELECTRON_RUN_AS_NODE = originalNodeMode;

if (!command) process.exit(1);
const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true });
child.once('error', (error: NodeJS.ErrnoException) => {
  // Do not echo arguments or environment values into diagnostics.
  process.stderr.write(`MCP process could not start (${error.code ?? 'spawn_error'}).\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
