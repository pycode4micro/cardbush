import type { ModelEvent } from "@cardbush/bush-protocol";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

/** A missing stored response invalidates this anchor, not the endpoint's capabilities. */
export function responsesContinuationMissing(
  failure: Extract<ModelEvent, { kind: "response_failed" }>,
  params: ResponseCreateParamsStreaming,
  parameter?: string | null,
): boolean {
  if (!params.previous_response_id || failure.retryable ||
      (failure.status !== undefined && ![400, 404].includes(failure.status))) return false;
  if (parameter && parameter !== "previous_response_id") return false;
  const code = failure.code.split(".").at(-1)!.replace(/[_-]/g, "").toLowerCase();
  if (["previousresponsenotfound", "previousresponseidnotfound", "previousresponseexpired", "previousresponseidexpired"].includes(code)) return true;
  const refersToPrevious = parameter === "previous_response_id" || /\bprevious[ _]response(?:[ _]id)?\b/i.test(failure.message);
  return refersToPrevious && /\b(?:not found|no response found|could not be found|does not exist|expired|no longer available)\b/i.test(failure.message);
}
