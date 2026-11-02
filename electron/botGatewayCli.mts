import { parseArgs, stripVTControlCharacters } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { uiText } from '@cardbush/platform/i18n';
import { openLocalChatClient, type ChatClient } from './agentLocalChat.mjs';
import { AgentHttpClient, agentBaseUrl } from './agentHttpClient.mjs';
import { BotGateway } from './botGateway.mjs';
import { serveBotGatewayHttp } from './botGatewayHttp.mjs';
import { readBotGatewayConfig, botError, BotGatewayError } from './botGatewayConfig.mjs';

export async function main(args = process.argv.slice(3)) {
  let language = Intl.DateTimeFormat().resolvedOptions().locale;
  let client: ChatClient | undefined, gateway: BotGateway | undefined, http: Awaited<ReturnType<typeof serveBotGatewayHttp>> | undefined;
  let removeSignals = () => {};
  try {
    const { values } = parseArgs({ args, options: { config: { type: 'string' }, 'state-dir': { type: 'string' },
      'profile-dir': { type: 'string' }, 'data-dir': { type: 'string' }, url: { type: 'string' },
      'token-file': { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' }, language: { type: 'string' } } });
    language = values.language ?? language;
    try { if (Intl.getCanonicalLocales(language).length !== 1) throw new Error(); }
    catch { throw new BotGatewayError('invalid_language'); }
    if (values.help) { process.stdout.write(uiText(language)('botGateway.help') + '\n'); return 0; }
    if (!values.config) throw new BotGatewayError('config_required');
    const config = await readBotGatewayConfig(resolve(values.config)); language = values.language ?? config.language;
    if (values.check) { process.stdout.write(uiText(language)('botGateway.configValid', { count: config.channels.length }) + '\n'); return 0; }
    if (values.url) {
      if (!values['token-file']) throw new BotGatewayError('token_file_required');
      const token = (await readFile(resolve(values['token-file']), 'utf8')).trim();
      if (token.length < 32) throw new BotGatewayError('missing_or_invalid_secret');
      client = new AgentHttpClient(agentBaseUrl(values.url), token);
    } else {
      if (values['token-file']) throw new BotGatewayError('url_required');
      client = await openLocalChatClient({ dataRoot: values['data-dir'], profileRoot: values['profile-dir'] });
    }
    gateway = await BotGateway.open(resolve(values['state-dir'] ?? join(homedir(), '.cardbush', 'bot-gateway')), { ...config, language }, client);
    http = await serveBotGatewayHttp(gateway);
    const host = http.host.includes(':') ? `[${http.host}]` : http.host;
    process.stdout.write(uiText(language)('botGateway.listening', { url: `http://${host}:${http.port}/api/bots/v1/`, count: config.channels.length }) + '\n');
    const stopped = new Promise<void>(done => {
      const stop = () => { removeSignals(); done(); };
      removeSignals = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
    await Promise.race([stopped, gateway.failure.then(error => { throw error; })]);
    return 0;
  } catch (error) {
    process.stderr.write(stripVTControlCharacters(botError(error, language).error.message) + '\n'); return 1;
  } finally {
    removeSignals();
    try { await http?.close(); } finally { try { await gateway?.close(); } finally { await client?.close(); } }
  }
}
