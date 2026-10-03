import { type ManagedModelConfig } from '../../types';
import { reasoningEffortSchema, resolveModelReasoningEffort, modelAuthenticationSchema } from '@cardbush/bush-protocol';

export function readManagedModelConfigs() {
  const raw =
    window.localStorage.getItem('cardbush_managed_model_configs') ??
    window.localStorage.getItem('cardbush_managed_models');
  if (!raw?.trim()) {
    return [];
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return [];
    }
    if (decoded.every((item) => typeof item === 'string')) {
      return decoded.map((modelName) => ({
        id: '',
        provider: 'custom',
        apiKey: '',
        modelName,
        baseUrl: '',
        maxContextTokens: undefined,
        maxCompletionTokens: undefined,
      }));
    }
    return decoded
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        id: String(item.id ?? ''),
        provider: String(item.provider ?? ''),
        authentication: modelAuthenticationSchema.optional().parse(item.authentication),
        apiKey: String(item.apiKey ?? ''),
        hasApiKey: item.hasApiKey === true,
        apiKeyMasked:
          typeof item.apiKeyMasked === 'string' ? item.apiKeyMasked : undefined,
        modelName: String(item.modelName ?? ''),
        baseUrl: String(item.baseUrl ?? ''),
        apiProtocol: item.apiProtocol as ManagedModelConfig['apiProtocol'],
        anthropicThinkingMode: item.anthropicThinkingMode as ManagedModelConfig['anthropicThinkingMode'],
        defaultHeaders: item.defaultHeaders as ManagedModelConfig['defaultHeaders'],
        reasoningEffort: reasoningEffortSchema.nullish().safeParse(item.reasoningEffort).data ?? null,
        maxContextTokens: normalizeMaxContextTokens(
          item.maxContextTokens ??
            item.max_context_tokens ??
            item.contextWindowTokens ??
            item.context_window_tokens ??
            item.maxInputTokens ??
            item.max_input_tokens,
        ),
        maxCompletionTokens: normalizeMaxCompletionTokens(
          item.maxCompletionTokens ??
            item.max_completion_tokens ??
            item.maxOutputTokens ??
            item.max_output_tokens,
        ),
      }));
  } catch {
    return [];
  }
}

export function normalizeManagedModelConfigs(source: ManagedModelConfig[]) {
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const result: ManagedModelConfig[] = [];
  for (const raw of source) {
    const provider = normalizeProvider(raw.provider);
    const modelName = raw.modelName.trim();
    const apiKey = raw.authentication?.kind === 'chatgpt' ? '' : raw.apiKey.trim();
    const baseUrl = raw.baseUrl.trim();
    const maxContextTokens = normalizeMaxContextTokens(raw.maxContextTokens);
    const maxCompletionTokens = normalizeMaxCompletionTokens(
      raw.maxCompletionTokens,
    );
    if (!provider || !modelName) {
      continue;
    }
    const key = raw.id.trim()
      ? `id:${raw.id.trim().toLowerCase()}`
      : `model:${provider.toLowerCase()}\u0000${modelName.toLowerCase()}\u0000${baseUrl.toLowerCase()}`;
    if (!seen.add(key)) {
      continue;
    }
    let id =
      raw.id.trim() || stableModelConfigId(provider, modelName, apiKey, baseUrl);
    let suffix = 2;
    const baseId = id;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    result.push({
      id,
      provider,
      authentication: modelAuthenticationSchema.optional().parse(raw.authentication),
      apiKey,
      hasApiKey: raw.authentication?.kind === 'chatgpt' ? false : raw.hasApiKey === true || Boolean(apiKey),
      apiKeyMasked: raw.authentication?.kind === 'chatgpt' ? undefined : raw.apiKeyMasked?.trim() || undefined,
      apiProtocol: raw.apiProtocol ?? 'openai_responses',
      anthropicThinkingMode: raw.anthropicThinkingMode,
      reasoningEffort: resolveModelReasoningEffort({ ...raw, reasoningEffort: reasoningEffortSchema.nullish().safeParse(raw.reasoningEffort).data }) ?? null,
      defaultHeaders: raw.defaultHeaders ?? {},
      modelName,
      baseUrl,
      ...(maxContextTokens ? { maxContextTokens } : {}),
      ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
    });
  }
  return result;
}

export function mergeLegacyModelCredentials(
  productHostModels: ManagedModelConfig[],
  legacyModels: ManagedModelConfig[],
) {
  let changed = false;
  const models = productHostModels.map((model) => {
    if (model.authentication?.kind === 'chatgpt' || model.hasApiKey === true || model.apiKey.trim()) {
      return model;
    }
    const id = model.id.trim().toLowerCase();
    const provider = normalizeProvider(model.provider);
    const modelName = model.modelName.trim().toLowerCase();
    const baseUrl = model.baseUrl.trim().toLowerCase();
    const candidates = legacyModels.filter((legacy) =>
      legacy.apiKey.trim() &&
      normalizeProvider(legacy.provider) === provider &&
      legacy.modelName.trim().toLowerCase() === modelName
    );
    const legacy = legacyModels.find((candidate) =>
      id && candidate.id.trim().toLowerCase() === id && candidate.apiKey.trim()
    ) ?? candidates.find((candidate) => candidate.baseUrl.trim().toLowerCase() === baseUrl)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!legacy) {
      return model;
    }
    changed = true;
    return {
      ...model,
      apiKey: legacy.apiKey.trim(),
      hasApiKey: true,
    };
  });
  return { models, changed };
}

function normalizeProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'google' ? 'gemini' : normalized;
}

function normalizeMaxContextTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function stableModelConfigId(
  provider: string,
  modelName: string,
  apiKey: string,
  baseUrl: string,
) {
  const raw = `${provider}\u0000${modelName}\u0000${apiKey}\u0000${baseUrl}`.toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `mm-${(hash >>> 0).toString(36)}`;
}

export function effectiveModels(configs: ManagedModelConfig[]) {
  const seen = new Set<string>();
  return configs
    .filter((item) => item.id.trim() && seen.add(item.id.trim().toLowerCase()));
}

export function defaultModelConfigId(configs: ManagedModelConfig[], selectedModel: string) {
  const selected = selectedModel.trim().toLowerCase();
  return (
    configs.find((item) => item.id.trim().toLowerCase() === selected)?.id ??
    configs.find((item) => item.modelName.trim().toLowerCase() === selected)?.id ??
    configs[0]?.id ??
    ''
  );
}

export function modelConfigSignature(configs: ManagedModelConfig[], defaultModelId: string) {
  return JSON.stringify({
    defaultModelId,
    configs: normalizeManagedModelConfigs(configs),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMaxCompletionTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
