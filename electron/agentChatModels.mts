import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { reasoningEffortsForProtocol, resolveModelReasoningEffort, type ModelApiProtocol, type ReasoningEffort } from '@cardbush/bush-protocol';
import type { ChatTerminal } from './agentChatCli.mjs';
import type { ChatClient } from './agentLocalChat.mjs';
import { chatExitCommands, isChatExitCommand } from './agentChatCompletion.mjs';
import { chatShellCommand, executeChatShell } from './agentChatShell.mjs';

type ChatModel = { id: string; modelName: string; apiProtocol?: ModelApiProtocol; reasoningEffort?: ReasoningEffort | null };
export type ChatModels = { defaultModelId: string; models: ChatModel[] };
export type ChatModelSelection = { modelId: string; reasoningEffort?: ReasoningEffort | null };

const effortLabels: Record<ReasoningEffort, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const effortDescriptions: Record<ReasoningEffort, string> = {
  none: 'No additional reasoning', low: 'Faster responses with lighter reasoning',
  medium: 'Balance speed and reasoning depth', high: 'More reasoning for complex tasks',
  xhigh: 'Extra reasoning depth; may take longer', max: 'Maximum reasoning; may take longer and use more tokens',
};
export function chatEffortLabel(model: ChatModel | undefined, override?: ReasoningEffort | null) {
  const effort = resolveModelReasoningEffort(model ?? {}, override);
  return effort ? effortLabels[effort] : 'Provider default';
}

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

/** Configuration input is a local command prompt, never a model message. */
export async function waitForChatConfiguration(io: ChatTerminal, signal: AbortSignal, exits: readonly string[] = chatExitCommands) {
  io.status('Run an editor here, e.g. vim "path/to/models.json". Exit the editor, then press Enter to reload.\n');
  while (!signal.aborted) {
    const answer = await io.ask(`Save, then press Enter to reload (${exits.join(', ')} to return): `, signal,
      { choices: exits.map(value => ({ value, description: 'Return' })) });
    if (answer === null || !answer.trim() || exits.includes(answer.trim())) return answer;
    const command = chatShellCommand(answer);
    if (command === undefined && answer.trim().startsWith('/')) {
      io.status('Use /shell COMMAND or enter an editor command; press Enter alone to reload.\n'); continue;
    }
    await executeChatShell(io, command ?? answer, process.cwd(), signal);
  }
  return null;
}

/** Loading configuration never makes a model request. */
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
    const answer = await waitForChatConfiguration(io, signal);
    if (answer === null || isChatExitCommand(answer)) return;
  }
}

/** Selection changes this conversation; App defaults remain owned by settings. */
export async function selectChatModel(config: ChatModels, current: ChatModelSelection, argument: string, io: ChatTerminal, signal: AbortSignal): Promise<ChatModelSelection> {
  let selection = argument.trim(), highlighted = current.modelId;
  while (!signal.aborted) {
    if (!selection) {
      const choices = config.models.map((model, index) => ({ value: model.id,
        label: `${index + 1}. ${model.modelName}${model.id === current.modelId ? ' (current)' : ''}`,
        description: `Effort: ${chatEffortLabel(model, model.id === current.modelId ? current.reasoningEffort : undefined)} · ${model.id}` }));
      if (!io.selectionMenus) io.status(`\nSelect Model and Effort\n${choices.map(item => `${item.label}  ${item.description}`).join('\n')}\n`);
      const answer = await io.ask('Select a number or model ID (/cancel to return): ', signal,
        { choices, picker: { title: 'Select Model and Effort', selected: highlighted, cancelValue: '/cancel' } });
      if (answer === null || answer.trim() === '/cancel') return current;
      selection = answer.trim() || highlighted;
    }
    const byName = config.models.filter(model => model.modelName === selection);
    const model = config.models.find(model => model.id === selection)
      ?? (/^[1-9]\d*$/.test(selection) ? config.models[Number(selection) - 1] : undefined)
      ?? (byName.length === 1 ? byName[0] : undefined);
    if (!model) { io.status('No unique model match. Use a number or ID from the list.\n'); return current; }
    highlighted = model.id;
    const override = model.id === current.modelId ? current.reasoningEffort : undefined;
    const effective = resolveModelReasoningEffort(model, override);
    const selectedValue = override === undefined ? 'configured' : override === null ? 'default' : effective;
    const choices = [
      { value: 'configured', label: 'Model setting', description: `Use shared App setting: ${chatEffortLabel(model)}` },
      { value: 'default', label: 'Provider default', description: 'Let the provider choose the reasoning level' },
      ...reasoningEffortsForProtocol(model.apiProtocol).map(value => ({ value, label: effortLabels[value], description: effortDescriptions[value] })),
    ].map((item, index) => ({ ...item, label: `${index + 1}. ${item.label}${item.value === selectedValue ? ' (current)' : ''}` }));
    while (!signal.aborted) {
      const title = `Select Reasoning Level for ${model.modelName}`;
      if (!io.selectionMenus) io.status(`\n${title}\n${choices.map(item => `${item.label}  ${item.description}`).join('\n')}\n`);
      const answer = await io.ask('Select an effort (/back for models, /cancel to return): ', signal,
        { choices, picker: { title, selected: selectedValue, cancelValue: '/back' } });
      if (answer === null || answer.trim() === '/cancel') return current;
      if (answer.trim() === '/back') break;
      const value = answer.trim() || selectedValue;
      const choice = choices.find(item => item.value === value)
        ?? (/^[1-9]\d*$/.test(value ?? '') ? choices[Number(value) - 1] : undefined);
      if (!choice) { io.status('Choose an effort from the list for this API protocol.\n'); continue; }
      signal.throwIfAborted();
      const result: ChatModelSelection = { modelId: model.id,
        ...(choice.value === 'configured' ? {} : { reasoningEffort: choice.value === 'default' ? null : choice.value as ReasoningEffort }) };
      io.status(`Switched to: ${model.modelName} · Effort: ${chatEffortLabel(model, result.reasoningEffort)}${choice.value === 'configured' ? ' (model setting)' : ''} (this CLI session; set defaults in /settings).\n`);
      return result;
    }
    selection = '';
  }
  return current;
}
