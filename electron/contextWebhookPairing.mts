import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { WebhookError, webhookConfigSchema } from './contextWebhookProtocol.mjs';
import { contextWebhookBody, contextWebhookIncoming } from './contextWebhookDefaults.js';

export const localPairingSchema = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(80),
  replyUrl: z.string().max(4096).default(''), replyHeaders: z.record(z.string(), z.string()).default({}),
}).strict().refine(value => {
  if (!value.replyUrl) return true;
  try { const url = new URL(value.replyUrl); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); }
  catch { return false; }
});
export type LocalWebhookPairing = z.infer<typeof localPairingSchema> & { secretHash: string; expiresAt: number;
  status: 'pending' | 'connected' | 'rejected'; connectionId?: string };
export function localPairingConfig(request: z.infer<typeof localPairingSchema>) {
  return webhookConfigSchema.parse({ name: request.name, enabled: true, url: request.replyUrl, headers: request.replyHeaders,
    parameters: {}, body: contextWebhookBody, incoming: contextWebhookIncoming });
}
export function assertLocalPairingRequest(req: IncomingMessage) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || req.headers.origin !== undefined
    || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none'
    || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host ?? '')) throw new WebhookError('local_request_required', 403);
}
export async function readWebhookJson(req: IncomingMessage, limit = 128 * 1024): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new WebhookError('json_required', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length; if (size > limit) throw new WebhookError('body_too_large', 413); chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WebhookError('invalid_json'); }
}
