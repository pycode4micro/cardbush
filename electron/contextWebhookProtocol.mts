import { z } from 'zod';
import { createHash } from 'node:crypto';

export class WebhookError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
const path = z.string().min(1).max(200).refine(value => value.split('.').every(key => /^[A-Za-z0-9_-]+$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)));
const headers = z.record(z.string(), z.string()).refine(value => Object.keys(value).length <= 32 && Object.entries(value).every(([key, val]) =>
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && !['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(key.toLowerCase()) && val.length <= 4096 && !/[\r\n]/.test(val)));
export const webhookConfigSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(80), enabled: z.boolean(),
  url: z.string().max(4096).refine(value => {
    if (!value) return true;
    try { const url = new URL(value); return !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); } catch { return false; }
  }),
  headers, parameters: z.record(z.string(), z.unknown()), body: z.unknown().refine((value): boolean => value !== undefined),
  incoming: z.object({ messageId: path, text: path, senderId: path, conversationId: path }).strict(),
}).strict().refine(value => JSON.stringify(value).length <= 64000);
export function field(input: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key)
    && !['__proto__', 'constructor', 'prototype'].includes(key) ? (value as Record<string, unknown>)[key] : undefined, input);
}
export function incomingMessage(input: unknown, mapping: z.infer<typeof webhookConfigSchema>['incoming']) {
  const identifier = z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1).max(200));
  return z.object({ messageId: identifier, text: z.string().trim().min(1).max(32000),
    senderId: identifier.optional(), conversationId: identifier.optional() }).parse(Object.fromEntries(Object.entries(mapping).map(([key, path]) => [key, field(input, path)])));
}
export type WebhookMessage = ReturnType<typeof incomingMessage>;
export function renderWebhookBody(template: unknown, values: Record<string, unknown>, depth = 0): unknown {
  if (depth > 16) throw new WebhookError('template_too_deep');
  if (typeof template === 'string') {
    const exact = /^\{\{([\w.-]+)\}\}$/.exec(template);
    const read = (key: string) => { const value = field(values, key); if (value === undefined) throw new WebhookError('template_variable_missing'); return value; };
    if (exact) return read(exact[1]);
    return template.replace(/\{\{([\w.-]+)\}\}/g, (_, key: string) => { const value = read(key); return typeof value === 'string' ? value : JSON.stringify(value); });
  }
  if (Array.isArray(template)) return template.map(item => renderWebhookBody(item, values, depth + 1));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderWebhookBody(value, values, depth + 1)]));
  return template;
}
export const webhookHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function deliverWebhook(config: z.infer<typeof webhookConfigSchema>, receipt: Record<string, unknown>, signal?: AbortSignal) {
  if (!config.url) return;
  const body = JSON.stringify(renderWebhookBody(config.body, { ...receipt, parameters: config.parameters }));
  if (Buffer.byteLength(body) > 256 * 1024) throw new WebhookError('reply_too_large');
  const response = await fetch(config.url, { method: 'POST', redirect: 'error', signal: signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { ...config.headers, 'Content-Type': 'application/json', 'X-CardBush-Event-ID': String(receipt.eventId) }, body });
  await response.body?.cancel();
  if (!response.ok) throw new WebhookError(`delivery_http_${response.status}`, 502);
}
