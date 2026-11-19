import { REPORT_DELIVERY_INSTRUCTIONS, withoutReportDeliveryPreface, type ModelMessage } from '@cardbush/bush-protocol';

export function isDeliveryGuidance(message: ModelMessage): message is Extract<ModelMessage, { role: 'user' }> {
  return message.role === 'user' && message.name === 'delivery_guidance' && message.visibility === 'internal';
}

export function hasDeliveryPolicy(messages: readonly ModelMessage[], policy: string): boolean {
  return messages.some(message => (message.role === 'system' || message.role === 'developer' || isDeliveryGuidance(message))
    && message.content.includes(policy));
}

export function withoutReportDeliveryPolicy(message: ModelMessage): ModelMessage {
  if (!isDeliveryGuidance(message)) return message;
  const content = withoutReportDeliveryPreface(message.content);
  return content === message.content ? message : { ...message, content };
}

export function projectReportDeliveryPrefix(messages: ModelMessage[]): ModelMessage[] {
  let seen = hasDeliveryPolicy(messages.filter(message => !isDeliveryGuidance(message)), REPORT_DELIVERY_INSTRUCTIONS);
  return messages.flatMap(message => {
    if (!isDeliveryGuidance(message) || !message.content.startsWith(REPORT_DELIVERY_INSTRUCTIONS)) return [message];
    if (!seen) { seen = true; return [message]; }
    return message.content === REPORT_DELIVERY_INSTRUCTIONS ? [] : [withoutReportDeliveryPolicy(message)];
  });
}
