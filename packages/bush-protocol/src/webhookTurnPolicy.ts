import type { RuntimeSessionTurnRequest } from './session.js';

export const WEBHOOK_FINAL_REPLY_INSTRUCTIONS = 'This request arrived through a Webhook bot. Structured user-question tools (request_user_input_async) are unavailable on this channel. If information or a choice is needed, ask a concise question in your final reply and finish this turn; the user will answer in a subsequent message. Do not wait for a question card, infer an answer, or execute steps that depend on the missing answer. Independent authorized work may be completed before the final question.';

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
