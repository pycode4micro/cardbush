/** Public defaults shared by the desktop UI and generic local clients. */
export const contextWebhookPort = 4791;
export const contextWebhookProtocol = 'cardbush.webhook.v1';
export const contextWebhookIncoming = { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' };
export const contextWebhookBody = { protocol: contextWebhookProtocol, type: '{{type}}', eventId: '{{eventId}}', sequence: '{{sequence}}',
  messageId: '{{messageId}}', sessionId: '{{sessionId}}', conversationId: '{{conversationId}}', senderId: '{{senderId}}',
  status: '{{status}}', reply: '{{reply}}', errorCode: '{{errorCode}}' };
