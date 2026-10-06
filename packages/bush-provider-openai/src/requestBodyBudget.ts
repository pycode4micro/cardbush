import type { ModelRequestBodyBudget } from "@cardbush/bush-runtime";

// Local dispatch budget, independent of token usage and upstream limits.
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 40_000_000;

export function requestBodyBudget(params: unknown, maxBytes = DEFAULT_REQUEST_BODY_MAX_BYTES): ModelRequestBodyBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxRequestBodyBytes must be a positive safe integer when provided.");
  }
  return { bytes: Buffer.byteLength(JSON.stringify(params), "utf8"), maxBytes };
}

export class RequestBodyBudgetError extends Error {
  readonly code = "provider_request_body_too_large";
  constructor(readonly budget: ModelRequestBodyBudget) {
    super(`Model request body is ${budget.bytes} bytes, exceeding the local ${budget.maxBytes}-byte budget. Compact the recorded conversation or send fewer images. Token usage is a separate limit; the original conversation has been preserved.`);
    this.name = "RequestBodyBudgetError";
  }
}

export function assertRequestBodyBudget(budget: ModelRequestBodyBudget): void {
  if (budget.bytes > budget.maxBytes) throw new RequestBodyBudgetError(budget);
}
