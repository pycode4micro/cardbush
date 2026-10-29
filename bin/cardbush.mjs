#!/usr/bin/env node
import { stripVTControlCharacters } from 'node:util';
import { readFile } from 'node:fs/promises';

try {
  if (['--version', '-v'].includes(process.argv[2])) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`CardBush ${version}\n`);
  } else if (process.argv[2] === 'worker') {
    const { main } = await import('../dist-electron/workerCli.mjs');
    process.exitCode = await main();
  } else if (process.argv[2] === 'serve') {
    process.argv.splice(2, 1);
    await import('../dist-electron/agentServiceCli.mjs');
  } else {
    const { main } = await import('../dist-electron/agentChatCli.mjs');
    process.exitCode = await main();
  }
} catch (error) {
  process.stderr.write(stripVTControlCharacters(error instanceof Error ? error.message : String(error)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') + '\n');
  process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1;
}
