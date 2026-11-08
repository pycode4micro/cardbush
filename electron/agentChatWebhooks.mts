import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { uiText } from '@cardbush/platform/i18n';
import type { AgentSendInput } from './agentTypes.js';
import type { ChatClient } from './agentLocalChat.mjs';
import type { ChatTerminal } from './agentChatCli.mjs';
import { terminalText } from './agentChatPresentation.mjs';
import type { BotConnectionStatus } from '@cardbush/bush-protocol';

// Match the CLI's current interface language; message catalogs still own all copy.
export const CLI_UI_LANGUAGE = 'en';
export type CliWebhookState = { enabled: boolean; listening: boolean; host: string; port: number; error?: string;
  connections: Array<{ id: string; name: string; enabled: boolean; status: BotConnectionStatus; pending: number }>; pairings: Array<{ requestId: string; name: string }> };
type Settings = Pick<AgentSendInput, 'modelId' | 'permissionMode' | 'language' | 'reasoningEffort'>;

export async function chatWebhookCommand(text: string, client: Pick<ChatClient, 'call'>, io: ChatTerminal, signal: AbortSignal,
  settings: Settings, language = CLI_UI_LANGUAGE): Promise<CliWebhookState | undefined> {
  const sessionId = PERSONAL_ASSISTANT_SESSION;
  const match = /^\s*\/webhook(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(text);
  const t = uiText(language);
  if (!match) { io.status(t('cliWebhook.usage') + '\n'); return; }
  const action = match[1] || 'connect', argument = match[2];
  if (!['connect', 'status', 'start', 'stop', 'disconnect', 'port'].includes(action)) { io.status(t('cliWebhook.usage') + '\n'); return; }
  const call = async (action: string, extra = {}) => client.call('webhooks.command', { action, sessionId, ...extra }, signal) as Promise<CliWebhookState>;
  try {
    if (action === 'stop') { const state = await call('stop'); io.status(t('cliWebhook.stopped') + '\n'); return state; }
    let state = await call(action === 'status' ? 'read' : action === 'port' ? 'listener' : 'start', action === 'port' ? { port: Number(argument) } : {});
    for (;;) {
      if (!state.enabled) { io.status(t('cliWebhook.inactive') + '\n'); return state; }
      if (!state.listening) { io.status(t('cliWebhook.portBusy', { port: state.port }) + '\n'); return state; }
      io.status(t('cliWebhook.listening', { port: state.port, session: terminalText(sessionId) }) + '\n');
      for (const c of state.connections) io.status(t('cliWebhook.connection', { name: terminalText(c.name), id: c.id, count: c.pending,
        status: t(!c.enabled ? 'webhook.disabled' : c.status === 'connected' ? 'webhook.connected' : 'webhook.offline') }) + '\n');
      if (!['connect', 'disconnect'].includes(action)) return state;
      const choices = action === 'connect'
        ? state.pairings.map((p, index) => ({ value: p.requestId, label: `${index + 1}. ${terminalText(p.name)}`, name: p.name }))
        : state.connections.map((c, index) => ({ value: c.id, label: `${index + 1}. ${terminalText(c.name)}`, name: c.name }));
      if (!choices.length) io.status(t(action === 'connect' ? 'cliWebhook.waiting' : 'cliWebhook.noConnections') + '\n');
      if (!io.interactive && !argument) { io.status(t('cliWebhook.noninteractive') + '\n'); return state; }
      if (!io.selectionMenus) for (const choice of choices) io.status(choice.label + '\n');
      const answer = argument ?? await io.ask(t('cliWebhook.choose'), signal, {
        choices: [...choices, { value: '/refresh', label: t('cliWebhook.refresh') }],
        picker: { title: t(action === 'connect' ? 'cliWebhook.connectTitle' : 'cliWebhook.disconnectTitle'), cancelValue: '/cancel' },
      });
      if (answer === null || answer.trim() === '/cancel') return state;
      if (!answer.trim() || answer.trim() === '/refresh') { state = await call('read'); continue; }
      const selected = choices.find(c => c.value === answer.trim()) ?? (/^[1-9]\d*$/.test(answer.trim()) ? choices[Number(answer.trim()) - 1] : undefined);
      if (!selected) { io.status(t('cliWebhook.noMatch') + '\n'); return state; }
      state = await call(action, { id: selected.value, ...(action === 'connect' ? { settings } : {}) });
      io.status(t(action === 'connect' ? 'cliWebhook.connected' : 'cliWebhook.disconnected', { name: terminalText(selected.name) }) + '\n');
      return state;
    }
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : '';
    io.status(t('cliWebhook.failed', { code: /^[a-z0-9_]+$/i.test(message) ? message : 'webhook_unavailable' }) + '\n');
  }
}
