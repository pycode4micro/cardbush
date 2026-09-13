import type { ModelRequestBodyBudget } from "@cardbush/bush-runtime";

// A conservative local dispatch budget, not a claim about any provider's limit.
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 32_000_000;

export function requestBodyBudget(params: unknown, maxBytes: number): ModelRequestBodyBudget {
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
