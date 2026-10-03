import { z } from 'zod';

/** Inference authorization is independent of the OpenAI connector login. */
export const SIWC = {
  issuer: 'https://auth.openai.com',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  authorization: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  resource: 'https://api.openai.com/v1',
  scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  planScope: 'chatgpt.tokens.use.direct',
  registrationClient: 'dynamic_agent_client',
  callbackPath: '/auth/callback',
  usageUrl: 'https://chatgpt.com/settings/usage',
} as const;

// Only this public reference may enter model configuration or Runtime commands.
export const modelAuthenticationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key') }).strict(),
  z.object({ kind: z.literal('chatgpt'), accountId: z.string().uuid() }).strict(),
]);
export type ModelAuthentication = z.infer<typeof modelAuthenticationSchema>;
export const siwcAccountSchema = z.object({
  id: z.string().uuid(), label: z.string(),
  state: z.enum(['signed_out', 'signing_in', 'signed_in', 'reauth_required']),
  planEnabled: z.boolean(), lastError: z.string().optional(),
}).strict();
export const siwcSnapshotSchema = z.object({ accounts: z.array(siwcAccountSchema),
  signingIn: z.boolean(), welcomePending: z.boolean(), connectedAccountId: z.string().uuid().optional(), lastError: z.string().optional() }).strict();
export type SiwcSnapshot = z.infer<typeof siwcSnapshotSchema>;
export const siwcActionSchema = z.object({
  action: z.enum(['login', 'cancel_login', 'logout', 'manage_usage', 'dismiss_welcome']),
  accountId: z.string().uuid().optional(),
}).strict();
export type SiwcAction = z.infer<typeof siwcActionSchema>;
export interface SiwcModel { id: string; name: string; }
