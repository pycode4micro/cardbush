import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatTerminal } from './agentChatCli.mjs';
import type { ChatClient } from './agentLocalChat.mjs';
import { chatExitCommands, isChatExitCommand } from './agentChatCompletion.mjs';

export type ChatModels = { defaultModelId: string; models: Array<{ id: string; modelName: string }> };

// Keep the existing models.json format. _comment is ordinary JSON data ignored
// by ProductModelConfigStore, so the editable example needs no second parser.
export const modelConfigurationExample = JSON.stringify({
  _comment: 'Fill in models below and save. _comment fields are documentation and may be kept or removed. Do not paste API keys into chat or commit them to a repository.',
  version: 1,
  defaultModelId: 'default',
  models: [{
    _comment: {
      id: 'Unique configuration ID. defaultModelId must match one of these IDs. Add multiple entries to models as needed.',
      provider: 'Provider identifier: openai for OpenAI-compatible services, or anthropic for Anthropic.',
      apiProtocol: 'Choose the service protocol: openai_responses, openai_chat_completions, or anthropic_messages.',
      model: 'Required: the actual model name accepted by the service, not a custom configuration label.',
      baseURL: 'Provider API base URL, e.g. https://your-provider.example/v1. Leave empty to use the protocol default.',
      apiKey: 'Your API key. Leave empty only if the service does not require one.',
    },
    id: 'default', provider: 'openai', apiProtocol: 'openai_responses', model: '', baseURL: '', apiKey: '',
  }],
}, null, 2) + '\n';

async function createIfMissing(path: string, content: string) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/** No credentials or requests leave the machine while waiting for configuration. */
export async function readChatModels(client: ChatClient, io: ChatTerminal, signal: AbortSignal): Promise<ChatModels | undefined> {
  const path = client.modelConfigurationPath;
  let explained = false;
  while (!signal.aborted) {
    let config: ChatModels | undefined;
    let invalid = false;
    try { config = await client.call('product.command', { kind: 'models.get' }, signal) as ChatModels; }
    catch (error) { if (!path || signal.aborted) throw error; invalid = true; }
    if (!path || config?.models.length) return config;
    if (!explained) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await createIfMissing(path, modelConfigurationExample);
      const example = join(dirname(path), 'models.example.json');
      await createIfMissing(example, modelConfigurationExample);
      io.status(`\nConfigure a model to continue.\nConfiguration file: ${path}\nAnnotated example: ${example}\nEdit and save the configuration file. Existing content will not be overwritten.\nThe _comment documentation fields may be kept.\n\n${modelConfigurationExample}`);
      explained = true;
    }
    if (invalid) io.status('Invalid model configuration. Check JSON syntax, required fields and the API protocol.\n');
    else if (config) io.status('No model configured.\n');
    if (!io.interactive) throw Object.assign(new Error(`Configure a model and try again: ${path}`), { exitCode: 2 });
    const answer = await io.ask('Save, then press Enter to reload (/quit, /q or /exit to quit): ', signal,
      { choices: chatExitCommands.map(value => ({ value, description: 'Exit' })) });
    if (answer === null || isChatExitCommand(answer)) return;
  }
}

/** Selection changes this conversation; App defaults remain owned by settings. */
export async function selectChatModel(config: ChatModels, current: string, argument: string, io: ChatTerminal, signal: AbortSignal) {
  let selection = argument.trim();
  if (!selection) {
    io.status(`\nModels (current: ${config.models.find(model => model.id === current)?.modelName ?? current})\n`);
    config.models.forEach((model, index) => io.status(`${index + 1}. ${model.modelName}  [${model.id}]${model.id === current ? ' · current' : ''}\n`));
    selection = (await io.ask('Select a number or model ID (Enter to keep, /cancel to return): ', signal, { choices: [
      ...config.models.map((model, index) => ({ value: model.id, label: `${index + 1}. ${model.modelName}`, description: model.id })),
      { value: '/cancel', description: 'Return to chat' },
    ] }))?.trim() ?? '';
  }
  if (!selection || selection === '/cancel') return current;
  const byName = config.models.filter(model => model.modelName === selection);
  const selected = config.models.find(model => model.id === selection)
    ?? (/^[1-9]\d*$/.test(selection) ? config.models[Number(selection) - 1] : undefined)
    ?? (byName.length === 1 ? byName[0] : undefined);
  if (!selected) { io.status('No unique model match. Use a number or ID from the list.\n'); return current; }
  io.status(`Switched to: ${selected.modelName} (this CLI session; set the default in /settings).\n`);
  return selected.id;
}
