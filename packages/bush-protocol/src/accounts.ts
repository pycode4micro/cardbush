import { z } from 'zod';

export const accountActionSchema = z.enum(['login', 'logout', 'cancel_login', 'reconnect', 'manage_apps']);
export const accountCommandSchema = z.object({ providerId: z.string().min(1).max(100), accountId: z.string().min(1).max(200), action: accountActionSchema }).strict();
const localized = z.object({ zh: z.string(), en: z.string() }).strict();
export const accountProviderSchema = z.object({
  id: z.string(), name: z.string(), availability: z.enum(['available', 'planned']),
  category: z.enum(['apps', 'models', 'identity', 'content']),
  description: localized, detail: localized, methods: z.array(z.enum(['oauth', 'api_key', 'qr_login', 'browser_session'])),
  documentationUrl: z.url().refine(url => url.startsWith('https://')),
  experimental: z.boolean().default(false),
}).strict();
export const managedAccountSchema = z.object({
  id: z.string(), providerId: z.string(), label: z.string(),
  state: z.enum(['signed_out', 'signing_in', 'signed_in', 'reauth_required', 'unavailable']),
  actions: z.array(accountActionSchema), lastError: z.string().optional(),
}).strict();
export const accountsSnapshotSchema = z.object({ providers: z.array(accountProviderSchema), accounts: z.array(managedAccountSchema),
  errors: z.array(z.object({ providerId: z.string(), code: z.literal('unavailable') }).strict()).default([]),
}).strict();
export type AccountAction = z.infer<typeof accountActionSchema>;
export type AccountCommand = z.infer<typeof accountCommandSchema>;
export type AccountProvider = z.infer<typeof accountProviderSchema>;
export type ManagedAccount = z.infer<typeof managedAccountSchema>;
export type AccountsSnapshot = z.infer<typeof accountsSnapshotSchema>;
