import type { ModelRequest } from '@cardbush/bush-protocol';
import { mcpDiscoveryResults, readLocalModelImage } from '@cardbush/bush-runtime';

export function namedMessageContent(name: string | undefined, content: string): string {
  return name ? `[${name}]\n${content}` : content;
}

/** Resolve media on a derived request; canonical history keeps durable file references. */
export async function resolveLocalImageInputs(request: ModelRequest): Promise<ModelRequest> {
  const messages = await Promise.all(request.messages.map(async (message) => {
    if (!("images" in message) || !message.images?.length) return message;
    return {
      ...message,
      images: await Promise.all(message.images.map(async (image) => ({
        ...image,
        url: await resolvedImageUrl(image.url),
      }))),
    };
  }));
  return { ...request, messages };
}

async function resolvedImageUrl(source: string): Promise<string> {
  const value = source.trim();
  if (/^https?:\/\//i.test(value) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return value;
  const { content, mime } = await readLocalModelImage(value);
  return `data:${mime};base64,${content.toString("base64")}`;
}

/** Identity stays in durable Runtime history for discovery recovery, not in model text. */
export function discoveryReceipt(output: Record<string, unknown>): string {
  const { protocol: _protocol, sessionId: _sessionId, next_step: _next, ...receipt } = output;
  if (receipt.more === false) delete receipt.more;
  return JSON.stringify(receipt);
}

/** Protocols without native discovery use the same compact function-call receipts. */
export function portableMessages(request: ModelRequest) {
  const discoveries = new Map([...mcpDiscoveryResults(request.messages, request.sessionId)].map(result => [result.messageIndex, result.output]));
  return request.messages.map((message, index) => message.role === 'tool' && discoveries.has(index)
    ? { ...message, content: discoveryReceipt({ ...discoveries.get(index)! }) } : message);
}
