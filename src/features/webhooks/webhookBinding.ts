import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { prepareRuntimeAgentRequest } from '../../backend/runtimeChat';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import type { ChatStreamRequest } from '../../backend/api';
import { assistantBackend } from '../assistant/assistantBackend';
import { readAssistantProfile } from '../assistant/assistantProfile';
import type { WebhookBinding } from '../../../electron/contextWebhookTypes';

export async function prepareWebhookBinding(prepare: () => Promise<ChatStreamRequest>, title: string): Promise<WebhookBinding> {
  const config = await prepare();
  if (config.sessionId !== PERSONAL_ASSISTANT_SESSION) throw Error('context_changed');
  const profile = readAssistantProfile();
  await assistantBackend.ensure(profile.name);
  const runtime = createDesktopRuntimeSession();
  try {
    const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, permissionMode: 'all_free', interactiveRequestsEnabled: false, userInput: 'Webhook connection' }, runtime);
    // The host loads authoritative history on each invocation; never export a transcript in configuration.
    parent.inputMessages = [{ messageId: 'binding', message: { role: 'user', content: 'Webhook connection' } }];
    const { generation } = await assistantBackend.read();
    if (generation === undefined) throw Error('service_unavailable');
    return { kind: 'assistant', sessionId: PERSONAL_ASSISTANT_SESSION, title, parent, profile, generation };
  } finally { runtime.dispose(); }
}
