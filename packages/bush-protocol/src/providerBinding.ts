import { z } from "zod";

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
  adapter: z.literal("openai_compatible"),
  apiKey: z.string().min(1),
  baseURL: z.string().min(1).optional(),
  defaultHeaders: z.record(z.string(), z.string()).default({}),
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
