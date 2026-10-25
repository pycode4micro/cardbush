import type { ModelRequest } from '@cardbush/bush-protocol';
import { isResourceAdmissionError, mcpDiscoveryResults, readLocalModelImage, type ModelStreamOptions } from '@cardbush/bush-runtime';
import { setTimeout as delay } from 'node:timers/promises';

export function namedMessageContent(name: string | undefined, content: string): string {
  return name ? `[${name}]\n${content}` : content;
}

/** Resolve media on a derived request; canonical history keeps durable file references. */
export async function resolveLocalImageInputs(request: ModelRequest, options: Pick<ModelStreamOptions, 'signal' | 'readImage'> = {}): Promise<ModelRequest> {
  options.signal?.throwIfAborted();
  // Resolve once per source and serially. Historical observations can repeat the
  // same blob; a rejected read must not leave other sandbox workers queued/running.
  const resolved = new Map<string, string>();
  const messages: ModelRequest['messages'] = [];
  for (const message of request.messages) {
    options.signal?.throwIfAborted();
    if (!("images" in message) || !message.images?.length) { messages.push(message); continue; }
    const images = [];
    for (const image of message.images) {
      options.signal?.throwIfAborted();
      const source = image.url.trim();
      if (!resolved.has(source)) resolved.set(source, await resolvedImageUrl(source, options));
      images.push({ ...image, url: resolved.get(source)! });
    }
    messages.push({ ...message, images });
  }
  return { ...request, messages };
}

async function resolvedImageUrl(value: string, options: Pick<ModelStreamOptions, 'signal' | 'readImage'>): Promise<string> {
  if (/^https?:\/\//i.test(value) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return value;
  const read = options.readImage ?? readLocalModelImage;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      const { content, mime } = await read(value, options.signal);
      options.signal?.throwIfAborted();
      return `data:${mime};base64,${content.toString("base64")}`;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!isResourceAdmissionError(error) || attempt >= 3) throw error;
      // Only this unstarted local read is retried through the same guard. No
      // provider dispatch, tool replay, image reinjection or host fallback.
      await delay(attempt * 500, undefined, { signal: options.signal });
    }
  }
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
