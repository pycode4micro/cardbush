// Exercise native readline under the test harness without a platform PTY.
// A file entry matches production and avoids eval-only flags on Runtime Workers.
process.stdin.isTTY = process.stdout.isTTY = process.stderr.isTTY = true;
process.env.TERM = 'xterm';
const { main } = await import('../../dist-electron/agentChatCli.mjs');
const { openClient } = await import('./agent-chat-fixture-client.mjs');
const { appendFile, readFile } = await import('node:fs/promises');
if (process.env.CARDBUSH_TEST_CHAT_READY) {
  const { NativeChatTerminal } = await import('../../dist-electron/agentChatTerminal.mjs');
  const ask = NativeChatTerminal.prototype.ask;
  NativeChatTerminal.prototype.ask = function (...args) {
    const pending = ask.apply(this, args);
    if (args[2] === true || args[2]?.chat) process.stderr.write('[Test: chat input ready]\n');
    return pending;
  };
}
if (process.env.CARDBUSH_TEST_HANDOFF_GATE) {
  const { NativeChatTerminal } = await import('../../dist-electron/agentChatTerminal.mjs');
  const { AgentHttpClient } = await import('../../dist-electron/agentHttpClient.mjs');
  const { setTimeout: delay } = await import('node:timers/promises');
  const finish = NativeChatTerminal.prototype.finishTurn, call = AgentHttpClient.prototype.call;
  let ended = false, paused = false;
  NativeChatTerminal.prototype.finishTurn = function (...args) { finish.apply(this, args); ended = true; };
  AgentHttpClient.prototype.call = async function (...args) {
    if (ended && !paused && args[0] === 'chat.jobs') {
      paused = true; process.stderr.write('[Test: observer handoff]\n');
      while (!await readFile(process.env.CARDBUSH_TEST_HANDOFF_GATE, 'utf8').catch(() => '')) await delay(10);
    }
    return call.apply(this, args);
  };
}
const openArtifact = process.env.CARDBUSH_TEST_OPEN_ARTIFACT_LOG ? async (path, kind) => {
  await appendFile(process.env.CARDBUSH_TEST_OPEN_ARTIFACT_LOG, JSON.stringify({ path, kind, content: kind === 'file' ? await readFile(path, 'utf8') : null }) + '\n');
} : undefined;
const shell = process.env.CARDBUSH_TEST_SHELL_LOG ? async (command, cwd) => {
  await appendFile(process.env.CARDBUSH_TEST_SHELL_LOG, JSON.stringify({ command, cwd }) + '\n');
  // Native Ctrl+C belongs to the child while the CLI releases the terminal.
  process.emit('SIGINT');
  return 0;
} : undefined;
try { process.exitCode = await main(process.argv.slice(2), { openArtifact, shell, openClient }); }
catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
