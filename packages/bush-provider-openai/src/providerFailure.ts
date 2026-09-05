import OpenAI from "openai";
import { BUSH_MODEL_EVENT_PROTOCOL, type ModelEvent } from "@cardbush/bush-protocol";
import { ModelImageInputError } from "@cardbush/bush-runtime";

type FailureEvent = Extract<ModelEvent, { kind: "response_failed" }>;
type Diagnostics = NonNullable<FailureEvent["diagnostics"]>;

const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);
const PERMANENT_CODES = new Set([
  "ERR_INVALID_URL", "ERR_INVALID_PROTOCOL", "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE", "ERR_HTTP_INVALID_HEADER_VALUE", "ERR_INVALID_CHAR",
  "UND_ERR_INVALID_ARG", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const QUOTA_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active"]);

function transportDiagnostics(error: unknown): Diagnostics {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const causeNames = new Set<string>();
  const causeCodes = new Set<string>();
  let errorName = "Error";
  // SDK errors often have name="Error"; the useful socket error is nested in cause
  // (occasionally AggregateError.errors). Never copy messages, stacks or request data.
  while (queue.length > 0 && seen.size < 8) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const item = value as { constructor?: { name?: string }; name?: unknown; code?: unknown; cause?: unknown; errors?: unknown[] };
    const name = item.constructor?.name === "Object" ? item.name : item.constructor?.name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_$]{0,79}$/.test(name)) {
      if (value === error) errorName = name;
      else causeNames.add(name);
    }
    if (typeof item.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(item.code)) {
      causeCodes.add(item.code);
    }
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors.slice(0, 8));
  }
  return { errorName, causeNames: [...causeNames], causeCodes: [...causeCodes] };
}

function retryAfterMs(headers?: Headers): number | undefined {
  const milliseconds = headers?.get("retry-after-ms");
  if (milliseconds?.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) {
    return Math.min(300_000, Math.round(Number(milliseconds)));
  }
  const value = headers?.get("retry-after")?.trim();
  if (!value) return undefined;
  const delay = Number.isFinite(Number(value))
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(300_000, Math.round(delay)) : undefined;
}

export function providerFailureEvent(
  requestId: string,
  sequence: number,
  error: unknown,
  aborted: boolean,
): FailureEvent {
  const base = {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: new Date().toISOString(),
    kind: "response_failed" as const,
  };
  if (aborted || error instanceof OpenAI.APIUserAbortError) {
    return { ...base, code: "request_aborted", message: "The model request was aborted.", retryable: false };
  }
  if (error instanceof ModelImageInputError) {
    return { ...base, code: error.code, message: error.message, retryable: false };
  }
  const diagnostics = transportDiagnostics(error);
  // An explicit HTTP response wins over any provider-supplied error code.
  // In particular, a 401 with code="ECONNRESET" must never become a socket retry.
  if (error instanceof OpenAI.APIError && error.status !== undefined) {
    const code = typeof error.code === "string" && error.code ? error.code : `provider_http_${error.status}`;
    const status = error.status;
    return {
      ...base,
      code,
      message: error.message,
      retryable: !QUOTA_CODES.has(code) &&
        (status === 408 || status === 409 || status === 429 || status >= 500),
      status,
      providerRequestId: error.requestID ?? undefined,
      retryAfterMs: retryAfterMs(error.headers),
      diagnostics,
    };
  }
  const permanentCode = diagnostics.causeCodes.find((code) => PERMANENT_CODES.has(code));
  const transientCode = diagnostics.causeCodes.find((code) => TRANSIENT_CODES.has(code));
  const timedOut = error instanceof OpenAI.APIConnectionTimeoutError;
  if (error instanceof OpenAI.APIConnectionError || permanentCode || transientCode) {
    const code = permanentCode ?? transientCode ?? (timedOut ? "provider_timeout" : "provider_connection_error");
    const message = permanentCode
      ? "The model connection configuration is invalid."
      : timedOut ? "Request timed out." : "Connection error.";
    return {
      ...base, code, message: `${message} (${code})`,
      retryable: !permanentCode, diagnostics,
    };
  }
  return {
    ...base,
    code: "provider_client_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    diagnostics,
  };
}
