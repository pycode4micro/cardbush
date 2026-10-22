// Exercise native readline under the test harness without a platform PTY.
// A file entry matches production and avoids eval-only flags on Runtime Workers.
process.stdin.isTTY = process.stdout.isTTY = process.stderr.isTTY = true;
process.env.TERM = 'xterm';
const { main } = await import('../../dist-electron/agentChatCli.mjs');
try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
