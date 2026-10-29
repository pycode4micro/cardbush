import { main } from '../../dist-electron/agentChatCli.mjs';
import { openClient } from './agent-chat-fixture-client.mjs';
try { process.exitCode = await main(process.argv.slice(2), { openClient }); }
catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
