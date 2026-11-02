import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { uiText } from '@cardbush/platform/i18n';

const identifier = z.string().trim().min(1).max(200);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const botMessageSchema = z.object({
  messageId: identifier, conversationId: identifier, senderId: identifier,
  text: z.string().trim().min(1).max(32_000), threadId: identifier.optional(),
}).strict();
export type BotMessage = z.infer<typeof botMessageSchema>;
export const botGatewayConfigSchema = z.object({
  version: z.literal(1), host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(4790),
  language: z.string().default('en').refine(value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }),
  modelId: z.string().min(1).optional(),
  channels: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), tokenEnv: envName,
    allowedSenders: z.array(identifier).min(1).optional(),
    callback: z.object({ url: z.string().url(), secretEnv: envName }).strict().optional(),
  }).strict()).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (new Set(value.channels.map(item => item.id)).size !== value.channels.length) context.addIssue({ code: 'custom', message: 'duplicate_channel_id' });
});
export type BotChannel = { id: string; token: string; allowedSenders?: string[]; callback?: { url: string; secret: string } };
export type BotGatewayConfig = Omit<z.infer<typeof botGatewayConfigSchema>, 'channels'> & { channels: BotChannel[] };
export class BotGatewayError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function botError(error: unknown, language: string) {
  const code = error instanceof BotGatewayError ? error.code : error instanceof z.ZodError ? 'invalid_request' : 'gateway_unavailable';
  return { error: { code, message: uiText(language)('botGateway.error', { code }) } };
}
export function parseBotGatewayConfig(input: unknown, env: NodeJS.ProcessEnv = process.env): BotGatewayConfig {
  const result = botGatewayConfigSchema.safeParse(input);
  if (!result.success) throw new BotGatewayError('invalid_config');
  const secret = (name: string) => {
    const value = env[name];
    if (!value || value.length < 32 || value.length > 4096 || /[\r\n]/.test(value)) throw new BotGatewayError('missing_or_invalid_secret');
    return value;
  };
  const channels = result.data.channels.map(channel => {
    let callback: BotChannel['callback'];
    if (channel.callback) {
      const url = new URL(channel.callback.url);
      if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)
        || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new BotGatewayError('invalid_callback_url');
      callback = { url: url.href, secret: secret(channel.callback.secretEnv) };
    }
    return { id: channel.id, token: secret(channel.tokenEnv), allowedSenders: channel.allowedSenders, callback };
  });
  return { ...result.data, channels };
}
export async function readBotGatewayConfig(path: string) {
  try { return parseBotGatewayConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error instanceof BotGatewayError) throw error; throw new BotGatewayError('invalid_config'); }
}
