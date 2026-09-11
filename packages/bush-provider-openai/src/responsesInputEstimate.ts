import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

/** Estimate the actual input representation, not the journal plus replay copy.
 * Encoded images are charged as images rather than millions of base64 tokens.
 * Opaque reasoning is retained once; only the service can count it precisely.
 */
export function estimateResponsesInputTokens(params: ResponseCreateParamsStreaming): number {
  let images = 0;
  const text = JSON.stringify({ input: params.input, tools: params.tools, reasoning: params.reasoning }, (_key, value) => {
    if (value?.type === "input_image") {
      images++;
      return { type: value.type, detail: value.detail };
    }
    return value;
  });
  return Math.ceil(text.length / 4) + images * 1024;
}
