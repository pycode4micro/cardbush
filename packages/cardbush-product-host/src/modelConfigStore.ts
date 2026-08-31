import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { replaceFile } from "./atomicFiles.js";

export interface ProductModelConfig {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface ProductModelConfigSnapshot {
  version: 1;
  defaultModelId: string;
  models: ProductModelConfig[];
}

export class ProductModelConfigStore {
  readonly #path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Product model config path must be absolute.");
    this.#path = resolve(path);
  }

  async read(): Promise<ProductModelConfigSnapshot> {
    try {
      return decodeSnapshot(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return emptySnapshot();
      throw error;
    }
  }

  async write(input: unknown): Promise<ProductModelConfigSnapshot> {
    const existing = await this.read();
    const snapshot = decodeUpdate(input, existing);
    await this.#writeSnapshot(snapshot);
    return snapshot;
  }

  async migrateMissingCredentials(input: unknown): Promise<number> {
    const existing = await this.read();
    const credentials = decodeLegacyCredentials(input);
    let imported = 0;
    const models = existing.models.map((config) => {
      if (config.apiKey) return config;
      const credential = matchingLegacyCredential(config, credentials);
      if (!credential) return config;
      imported += 1;
      return { ...config, apiKey: credential.apiKey };
    });
    if (imported === 0) return 0;
    await this.#writeSnapshot({ ...existing, models });
    return imported;
  }

  async #writeSnapshot(snapshot: ProductModelConfigSnapshot): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await replaceFile(temp, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }

  publicPayload(snapshot: ProductModelConfigSnapshot): Record<string, unknown> {
    return {
      version: snapshot.version,
      defaultModelId: snapshot.defaultModelId,
      models: snapshot.models.map((config) => ({
        id: config.id,
        provider: config.provider,
        modelName: config.model,
        apiKey: "",
        hasApiKey: Boolean(config.apiKey),
        apiKeyMasked: config.apiKey ? maskSecret(config.apiKey) : undefined,
        baseUrl: config.baseURL ?? "",
        maxContextTokens: config.maxContextTokens,
        maxCompletionTokens: config.maxOutputTokens,
      })),
    };
  }
}

interface LegacyModelCredential {
  id: string;
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
}

function decodeLegacyCredentials(input: unknown): LegacyModelCredential[] {
  const value = record(input, "Legacy model configuration must be an object.");
  if (!Array.isArray(value.models)) return [];
  return value.models.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const config = candidate as Record<string, unknown>;
    const apiKey = optionalString(config.apiKey ?? config.api_key);
    const provider = optionalString(config.provider);
    const model = optionalString(config.model ?? config.modelName ?? config.model_name);
    if (!apiKey || !provider || !model) return [];
    return [{
      id: optionalString(config.id ?? config.modelId ?? config.model_id) ?? "",
      provider,
      model,
      baseURL: optionalString(config.baseURL ?? config.baseUrl ?? config.base_url) ?? "",
      apiKey,
    }];
  });
}

function matchingLegacyCredential(
  config: ProductModelConfig,
  credentials: LegacyModelCredential[],
): LegacyModelCredential | undefined {
  const provider = normalizedIdentity(config.provider);
  const model = normalizedIdentity(config.model);
  const baseURL = normalizedEndpoint(config.baseURL ?? "");
  const candidates = credentials.filter((candidate) =>
    normalizedIdentity(candidate.provider) === provider &&
    normalizedIdentity(candidate.model) === model &&
    normalizedEndpoint(candidate.baseURL) === baseURL
  );
  return candidates.find((candidate) => candidate.id && candidate.id === config.id)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
}

function normalizedIdentity(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "google" ? "gemini" : normalized;
}

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function decodeUpdate(
  input: unknown,
  existing: ProductModelConfigSnapshot,
): ProductModelConfigSnapshot {
  const value = record(input, "Model configuration update must be an object.");
  if (!Array.isArray(value.models)) throw new Error("models must be an array.");
  const prior = new Map(existing.models.map((config) => [config.id, config]));
  const models = value.models.map((candidate) => {
    const config = record(candidate, "Model configuration must be an object.");
    const id = requiredString(config.id, "id");
    const previous = prior.get(id);
    const suppliedApiKey = optionalString(config.apiKey ?? config.api_key);
    const maxContextTokens = positiveInteger(
      config.maxContextTokens ?? config.max_context_tokens,
    );
    const maxOutputTokens = positiveInteger(
      config.maxOutputTokens ?? config.maxCompletionTokens ?? config.max_completion_tokens,
    );
    assertValidTokenLimits(id, maxContextTokens, maxOutputTokens);
    return {
      id,
      provider: requiredString(config.provider, "provider"),
      model: requiredString(config.model ?? config.modelName ?? config.model_name, "model"),
      apiKey: suppliedApiKey ?? previous?.apiKey ?? "",
      ...optionalProperty("baseURL", optionalString(config.baseURL ?? config.baseUrl ?? config.base_url)),
      ...optionalProperty("defaultHeaders", stringRecord(config.defaultHeaders ?? config.default_headers)),
      ...optionalProperty("maxContextTokens", maxContextTokens),
      ...optionalProperty("maxOutputTokens", maxOutputTokens),
    } satisfies ProductModelConfig;
  });
  const ids = new Set<string>();
  for (const config of models) {
    if (ids.has(config.id)) throw new Error(`Duplicate model configuration: ${config.id}`);
    ids.add(config.id);
  }
  const requestedDefault = optionalString(value.defaultModelId ?? value.default_model_id) ?? "";
  const defaultModelId = ids.has(requestedDefault) ? requestedDefault : models[0]?.id ?? "";
  return { version: 1, defaultModelId, models };
}

function decodeSnapshot(input: unknown): ProductModelConfigSnapshot {
  const value = record(input, "Stored model configuration must be an object.");
  if (value.version !== 1 || !Array.isArray(value.models)) {
    throw new Error("Stored model configuration has an unsupported schema.");
  }
  const models = value.models.map((candidate) => {
    const config = record(candidate, "Stored model configuration must be an object.");
    const id = requiredString(config.id, "id");
    const maxContextTokens = positiveInteger(config.maxContextTokens);
    const maxOutputTokens = positiveInteger(config.maxOutputTokens);
    assertValidTokenLimits(id, maxContextTokens, maxOutputTokens);
    return {
      id,
      provider: requiredString(config.provider, "provider"),
      model: requiredString(config.model, "model"),
      apiKey: optionalString(config.apiKey) ?? "",
      ...optionalProperty("baseURL", optionalString(config.baseURL)),
      ...optionalProperty("defaultHeaders", stringRecord(config.defaultHeaders)),
      ...optionalProperty("maxContextTokens", maxContextTokens),
      ...optionalProperty("maxOutputTokens", maxOutputTokens),
    };
  });
  const defaultModelId = optionalString(value.defaultModelId) ?? "";
  return {
    version: 1,
    defaultModelId: models.some((config) => config.id === defaultModelId)
      ? defaultModelId
      : models[0]?.id ?? "",
    models,
  };
}

function emptySnapshot(): ProductModelConfigSnapshot {
  return { version: 1, defaultModelId: "", models: [] };
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 3)}${"*".repeat(Math.min(12, value.length - 6))}${value.slice(-3)}`;
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(message);
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, field: string): string {
  const value = optionalString(input);
  if (!value) throw new Error(`${field} is required.`);
  return value;
}

function optionalString(input: unknown): string | undefined {
  const value = typeof input === "string" ? input.trim() : "";
  return value || undefined;
}

function positiveInteger(input: unknown): number | undefined {
  if (input == null || input === "") return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) throw new Error("Token limits must be positive integers.");
  return value;
}

function assertValidTokenLimits(
  modelId: string,
  maxContextTokens: number | undefined,
  maxOutputTokens: number | undefined,
): void {
  if (
    maxContextTokens !== undefined &&
    maxOutputTokens !== undefined &&
    maxOutputTokens >= maxContextTokens
  ) {
    throw new Error(
      `Model ${modelId}: maxOutputTokens (${maxOutputTokens}) must be less than maxContextTokens (${maxContextTokens}).`,
    );
  }
}

function stringRecord(input: unknown): Record<string, string> | undefined {
  if (input == null) return undefined;
  const value = record(input, "defaultHeaders must be an object.");
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error("defaultHeaders values must be strings.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: Value };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
