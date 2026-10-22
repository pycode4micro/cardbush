#!/usr/bin/env node
import { main, terminalText } from '../dist-electron/agentChatCli.mjs';

main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(terminalText(error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1;
});
