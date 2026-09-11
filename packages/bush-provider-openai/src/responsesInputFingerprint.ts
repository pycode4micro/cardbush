import { createHash } from "node:crypto";
import type { ModelRequest, ProviderInputProjection } from "@cardbush/bush-protocol";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import { estimateResponsesInputTokens } from "./responsesInputEstimate.js";

/** No prompt text, credentials, or tool results are written to diagnostics. */
export function responsesInputFingerprint(
  full: ResponseCreateParamsStreaming,
  sent: ResponseCreateParamsStreaming,
  binding: ModelRequest["providerBinding"],
): ProviderInputProjection {
  const parameters = {
    model: full.model, providerBinding: binding,
    tools: full.tools, reasoning: full.reasoning,
    temperature: full.temperature, top_p: full.top_p, max_output_tokens: full.max_output_tokens,
  };
  return {
    format: "openai.responses.input.v1",
    transport: sent.previous_response_id ? "continuation" : "full",
    parameterDigests: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, hash(value)])),
    inputDigests: (Array.isArray(full.input) ? full.input : [full.input]).map(hash),
    tokenEstimate: { method: "responses-input-chars-v1", tokens: estimateResponsesInputTokens(full),
      inputParametersDigest: hash({ model: full.model, providerBinding: binding,
        tools: full.tools, reasoning: full.reasoning, temperature: full.temperature, top_p: full.top_p }) },
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}
