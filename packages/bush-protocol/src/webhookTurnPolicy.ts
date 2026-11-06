import { renderPromptTemplate } from '@cardbush/platform/prompts';
import type { RuntimeSessionTurnRequest } from './session.js';

export const WEBHOOK_FINAL_REPLY_INSTRUCTIONS = renderPromptTemplate('webhook-final-reply-instructions');

/** Host-owned channel policy. Do not change the user's ordinary conversation settings. */
export function applyWebhookTurnPolicy(request: RuntimeSessionTurnRequest): RuntimeSessionTurnRequest {
  const disabled = Array.isArray(request.metadata.disabledTools) ? request.metadata.disabledTools as string[] : [];
  return { ...request, permissionMode: 'all_free',
    requestCapabilities: { ...request.requestCapabilities, vision: request.requestCapabilities?.vision === true, interactiveRequests: false },
    metadata: { ...request.metadata, permissionMode: 'all_free', userQuestionDelivery: 'final_reply',
      disabledTools: [...new Set([...disabled, 'request_user_input_async'])] },
    prefixMessages: [...request.prefixMessages.filter(message => message.role !== 'developer' || message.name !== 'webhook_delivery_policy'),
      { role: 'developer', name: 'webhook_delivery_policy', content: WEBHOOK_FINAL_REPLY_INSTRUCTIONS }],
  };
}
