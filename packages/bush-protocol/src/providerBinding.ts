import { z } from "zod";

export const modelApiProtocolSchema = z.enum(["openai_responses", "openai_chat_completions", "anthropic_messages"]);
export type ModelApiProtocol = z.infer<typeof modelApiProtocolSchema>;
export const anthropicThinkingModeSchema = z.enum(['adaptive', 'budget']);

export const modelHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[^\x20-\x7e\t]/.test(value) ||
      names.has(key) || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key)) {
      ctx.addIssue({ code: 'custom', message: `Invalid or duplicate HTTP header: ${name}` });
    }
    names.add(key);
  }
});

export function modelApiBaseURL(protocol: ModelApiProtocol, baseURL?: string): string {
  const value = baseURL?.trim() || (protocol === 'anthropic_messages' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  const url = z.url({ protocol: /^https?$/, normalize: true }).parse(value);
  if (/^https?:\/\/[^/]*@/i.test(url) || /[?#]/.test(url)) {
    throw new Error('API base URL must be an HTTP(S) URL without credentials, query or fragment.');
  }
  return url.replace(/\/+$/, '');
}

/** Gateway behavior follows the destination, not the user-editable provider label. */
export function modelApiGateway(baseURL?: string): 'opencode' | 'openrouter' | undefined {
  if (!baseURL) return;
  const url = z.url({ protocol: /^https?$/, hostname: /^(opencode|openrouter)\.ai$/i, normalize: true }).safeParse(baseURL);
  if (!url.success || /^https?:\/\/[^/]*@/i.test(url.data)) return;
  return /^https?:\/\/openrouter\.ai(?:[/:]|$)/i.test(url.data) ? 'openrouter' : 'opencode';
}

/** Resolve on every request; never mutate a shared client's defaults. */
export function modelRequestHeaders(baseURL: string | undefined, defaults: Record<string, string> | undefined, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': 'CardBush/1.0' };
  for (const [name, value] of Object.entries(modelHeadersSchema.parse(defaults ?? {}))) {
    headers[name.toLowerCase()] = value.replaceAll('{{sessionId}}', sessionId);
  }
  if (modelApiGateway(baseURL) === 'opencode') {
    // OpenCode routes all main/auxiliary calls by the stable conversation identity.
    headers['x-opencode-session'] = sessionId;
  }
  if (modelApiGateway(baseURL) === 'openrouter') {
    // Routing/cache affinity belongs to the executing conversation, not the SDK client.
    headers['x-session-id'] = z.string().min(1).max(256).parse(sessionId);
    if (!headers['x-openrouter-title'] && !headers['x-title']) headers['x-openrouter-title'] = 'CardBush';
  }
  return modelHeadersSchema.parse(headers);
}

export const BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL =
  "bush.provider_binding_config.v1" as const;
export const BUSH_PROVIDER_BINDING_RESULT_PROTOCOL =
  "bush.provider_binding_result.v1" as const;
export const UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND =
  "runtime.upsert_provider_binding" as const;
export const REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND =
  "runtime.remove_provider_binding" as const;

export const runtimeProviderBindingRefSchema = z.object({
  bindingId: z.string().min(1),
  revision: z.string().min(1),
});

export type RuntimeProviderBindingRef = z.infer<
  typeof runtimeProviderBindingRefSchema
>;

export const runtimeProviderBindingConfigSchema = z.object({
  protocol: z.literal(BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL),
  bindingId: z.string().min(1),
  adapter: modelApiProtocolSchema,
  anthropicThinkingMode: anthropicThinkingModeSchema.optional(),
  apiKey: z.string().min(1),
  baseURL: z.string().min(1).optional(),
  defaultHeaders: modelHeadersSchema.default({}),
  timeoutMs: z.number().int().positive().optional(),
});

export type RuntimeProviderBindingConfig = z.infer<
  typeof runtimeProviderBindingConfigSchema
>;

export const runtimeProviderBindingIdentitySchema = z.object({
  bindingId: z.string().min(1),
});

export const runtimeProviderBindingResultSchema = z.discriminatedUnion("status", [
  z.object({
    protocol: z.literal(BUSH_PROVIDER_BINDING_RESULT_PROTOCOL),
    status: z.literal("configured"),
    binding: runtimeProviderBindingRefSchema,
  }),
  z.object({
    protocol: z.literal(BUSH_PROVIDER_BINDING_RESULT_PROTOCOL),
    status: z.enum(["removed", "not_found"]),
    bindingId: z.string().min(1),
  }),
]);

export type RuntimeProviderBindingResult = z.infer<
  typeof runtimeProviderBindingResultSchema
>;
