#!/usr/bin/env node
// Match the published npm command: one service implementation, two package bins.
if (!['--version', '-v'].includes(process.argv[2])) process.argv.splice(2, 0, 'serve');
await import('./cardbush.mjs');
