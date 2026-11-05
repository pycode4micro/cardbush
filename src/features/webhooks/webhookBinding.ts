import { prepareRuntimeAgentRequest } from '../../backend/runtimeChat';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import type { ChatStreamRequest } from '../../backend/api';
import { assistantBackend } from '../assistant/assistantBackend';
import { readAssistantProfile } from '../assistant/assistantProfile';
import type { WebhookBinding } from '../../../electron/contextWebhookTypes';

export async function prepareWebhookBinding(prepare: () => Promise<ChatStreamRequest>, kind: WebhookBinding['kind'], sessionId: string, title: string): Promise<WebhookBinding> {
  const config = await prepare();
  if (config.sessionId !== sessionId) throw Error('context_changed');
  const profile = kind === 'assistant' ? readAssistantProfile() : undefined;
  if (profile) await assistantBackend.ensure(profile.name);
  const runtime = createDesktopRuntimeSession();
  try {
    const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, permissionMode: 'all_free', interactiveRequestsEnabled: false, userInput: 'Webhook connection' }, runtime);
    // The host loads authoritative history on each invocation; never export a transcript in configuration.
    parent.inputMessages = [{ messageId: 'binding', message: { role: 'user', content: 'Webhook connection' } }];
    return { kind, sessionId, title, parent, ...(profile ? { profile, generation: (await assistantBackend.read()).generation } : {}) };
  } finally { runtime.dispose(); }
}
