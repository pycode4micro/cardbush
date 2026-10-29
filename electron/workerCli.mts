import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { supportsRemoteInteraction } from '@cardbush/bush-protocol';
import { openLocalChatClient } from './agentLocalChat.mjs';
import { terminalText } from './agentChatPresentation.mjs';
import type { AgentConnection, AgentInfo } from './agentTypes.js';

export async function main(args = process.argv.slice(3)): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, url: { type: 'string' }, 'token-file': { type: 'string' }, name: { type: 'string' },
  } });
  const action = positionals[0] ?? 'list', id = positionals[1];
  if (values.help) {
    process.stdout.write('Remote subagent workers (local host registrations)\n\ncardbush worker list\ncardbush worker add --name NAME --url HTTPS_URL --token-file PATH\ncardbush worker verify ID\ncardbush worker remove ID\n\nRegister a connection, then ask your local Agent to save a reusable subagent role for its returned ID.\nCredentials stay in the local service store. No remote chat or configuration copying.\n');
    return 0;
  }
  if (!['list', 'add', 'verify', 'remove'].includes(action) || positionals.length > (['verify', 'remove'].includes(action) ? 2 : 1)) throw new Error('Use cardbush worker --help.');
  if (['verify', 'remove'].includes(action) && !id) throw new Error('A worker connection ID is required.');
  if (action !== 'add' && Object.values(values).some(value => value !== undefined)) throw new Error('Connection options apply only to worker add.');
  let connection: { name: string; transport: 'http'; url: string; token: string } | undefined;
  if (action === 'add') {
    if (!values.name?.trim() || !values.url || !values['token-file']) throw new Error('Provide --name, --url and --token-file.');
    const token = (await readFile(values['token-file'], 'utf8')).trim();
    if (!token || token.length > 16_384) throw new Error('Invalid token file.');
    connection = { name: values.name, transport: 'http', url: values.url, token };
  }
  const client = await openLocalChatClient();
  try {
    if (action === 'verify') {
      const info = await client.call('workers.command', { action: 'verify', id }) as AgentInfo;
      if (!supportsRemoteInteraction(info.capabilities.workerInteraction)) throw new Error('This service needs an update before worker interactions are available.');
      process.stdout.write(terminalText(`Verified ${info.name} (${info.id})`) + '\n');
    } else {
      const before = action === 'add' ? await client.call('workers.command', { action: 'list' }) as AgentConnection[] : [];
      const items = await client.call('workers.command', { action: action === 'add' ? 'save' : action, ...(connection ? { connection } : {}), ...(id ? { id } : {}) }) as AgentConnection[];
      for (const item of items.filter(item => action !== 'add' || !before.some(old => old.id === item.id))) {
        process.stdout.write(terminalText(`${item.id}\t${item.name}\t${item.agentId ?? 'unverified'}`) + '\n');
        if (action === 'add') {
          // Saving succeeded even if verification fails. Keep the ID for explicit retry.
          const info = await client.call('workers.command', { action: 'verify', id: item.id }) as AgentInfo;
          if (!supportsRemoteInteraction(info.capabilities.workerInteraction)) throw new Error(`Saved ${item.id}; update the remote service, then run cardbush worker verify ${item.id}.`);
          process.stdout.write(terminalText(`Verified ${info.id}. Ask your local Agent to register a subagent role for connection ${item.id}.`) + '\n');
        }
      }
    }
    return 0;
  } finally { await client.close(); }
}
