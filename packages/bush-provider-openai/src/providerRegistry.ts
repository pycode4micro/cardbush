import { createHash } from "node:crypto";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_PROVIDER_BINDING_RESULT_PROTOCOL,
  runtimeProviderBindingConfigSchema,
  runtimeProviderBindingIdentitySchema,
  type ModelEvent,
  type ModelRequest,
  type RuntimeProviderBindingConfig,
  type RuntimeProviderBindingResult,
} from "@cardbush/bush-protocol";
import type { ModelProvider, ModelStreamOptions } from "@cardbush/bush-runtime";

import {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderConfig,
} from "./responses.js";

export interface OpenAIResponsesProviderRegistryOptions {
  fallbackProvider?: ModelProvider;
  createRevision?: (config: RuntimeProviderBindingConfig) => string;
  createProvider?: (config: OpenAIResponsesProviderConfig) => ModelProvider;
}

/**
 * Resolves an immutable provider binding for each model request.
 *
 * Secrets stay in this process-local registry. Model requests, checkpoints and
 * Runtime events carry only a binding ID and revision. Updating the same
 * binding ID creates a new revision while older revisions remain usable by
 * already-running Turns.
 */
export class OpenAIResponsesProviderRegistry implements ModelProvider {
  readonly #providers = new Map<string, ModelProvider>();
  readonly #bindingKeys = new Map<string, Set<string>>();
  readonly #fallbackProvider?: ModelProvider;
  readonly #createRevision: (config: RuntimeProviderBindingConfig) => string;
  readonly #createProvider: (
    config: OpenAIResponsesProviderConfig,
  ) => ModelProvider;

  constructor(options: OpenAIResponsesProviderRegistryOptions = {}) {
    this.#fallbackProvider = options.fallbackProvider;
    this.#createRevision = options.createRevision ?? bindingRevision;
    this.#createProvider =
      options.createProvider ??
      ((config) => new OpenAIResponsesProvider(config));
  }

  upsert(input: unknown): RuntimeProviderBindingResult {
    const config = runtimeProviderBindingConfigSchema.parse(input);
    const revision = this.#createRevision(config);
    const key = bindingKey(config.bindingId, revision);
    this.#providers.set(key, this.#createProvider(toProviderConfig(config)));
    const revisions = this.#bindingKeys.get(config.bindingId) ?? new Set<string>();
    revisions.add(key);
    this.#bindingKeys.set(config.bindingId, revisions);
    return {
      protocol: BUSH_PROVIDER_BINDING_RESULT_PROTOCOL,
      status: "configured",
      binding: { bindingId: config.bindingId, revision },
    };
  }

  remove(input: unknown): RuntimeProviderBindingResult {
    const { bindingId } = runtimeProviderBindingIdentitySchema.parse(input);
    const revisions = this.#bindingKeys.get(bindingId);
    if (!revisions) {
      return {
        protocol: BUSH_PROVIDER_BINDING_RESULT_PROTOCOL,
        status: "not_found",
        bindingId,
      };
    }
    for (const key of revisions) this.#providers.delete(key);
    this.#bindingKeys.delete(bindingId);
    return {
      protocol: BUSH_PROVIDER_BINDING_RESULT_PROTOCOL,
      status: "removed",
      bindingId,
    };
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelEvent> {
    const reference = request.providerBinding;
    const provider = reference
      ? this.#providers.get(bindingKey(reference.bindingId, reference.revision))
      : this.#fallbackProvider;
    if (!provider) {
      yield providerFailure(
        request.requestId,
        reference ? "runtime_provider_binding_not_found" : "runtime_provider_not_configured",
        reference
          ? `Provider binding ${reference.bindingId}@${reference.revision} is unavailable.`
          : "The Electron Runtime Host has no configured model provider.",
      );
      return;
    }
    yield* provider.stream(request, options);
  }
}

function toProviderConfig(
  config: RuntimeProviderBindingConfig,
): OpenAIResponsesProviderConfig {
  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.defaultHeaders,
    timeoutMs: config.timeoutMs,
  };
}

function bindingKey(bindingId: string, revision: string): string {
  return JSON.stringify([bindingId, revision]);
}

function bindingRevision(config: RuntimeProviderBindingConfig): string {
  const canonical = JSON.stringify({
    adapter: config.adapter,
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? null,
    defaultHeaders: Object.fromEntries(
      Object.entries(config.defaultHeaders).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    timeoutMs: config.timeoutMs ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function providerFailure(
  requestId: string,
  code: string,
  message: string,
): ModelEvent {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence: 0,
    createdAt: new Date().toISOString(),
    kind: "response_failed",
    code,
    message,
    retryable: false,
  };
}
