import type { ResponseCreateParamsStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import type { ModelEvent } from "@cardbush/bush-protocol";

/** Policy observation, not a claim that every individual extension is unsupported. */
export const RESPONSES_COMPATIBILITY_CAPABILITY = "responses_generation_compatibility";

/** A fallback can only address an explicitly rejected feature present on the wire.
 * HTTP/auth/transport failures and ordinary input validation are not that evidence. */
export function responsesCompatibilityRejection(
  failure: Extract<ModelEvent, { kind: 'response_failed' }>,
  params: ResponseCreateParamsStreaming,
  parameter?: string | null,
): boolean {
  if (failure.retryable || (failure.status !== undefined && ![400, 422].includes(failure.status))) return false;
  if (parameter && /\b(?:parameters|schema)\b/i.test(parameter)) return false;
  const code = failure.code.toLowerCase();
  const message = failure.message;
  const unsupported = /(?:unsupported|not_supported|not_implemented|unknown_(?:parameter|field|tool|type)|unrecognized_(?:parameter|field|tool|type))/.test(code) ||
    /\b(?:unsupported|not supported|does not support|not implemented|unknown (?:parameter|field|tool|type)|unrecognized (?:parameter|field|tool|type))\b/i.test(message);
  if (!unsupported) return false;
  const feature = `${parameter ?? ''} ${message}`;
  const toolTypeIndex = parameter?.match(/^tools(?:\[(\d+)\]|\.(\d+))\.type$/);
  const rejectedNativeTool = toolTypeIndex && params.tools?.[Number(toolTypeIndex[1] ?? toolTypeIndex[2])]?.type === 'tool_search';
  if (params.tools?.some(tool => tool.type === 'tool_search') &&
      (/\b(?:tool_search|additional_tools)\b/i.test(feature) || rejectedNativeTool)) return true;
  if (params.previous_response_id && /\bprevious_response_id\b/i.test(feature)) return true;
  if (params.store && /\bstore\b/i.test(feature)) return true;
  return /\b(?:function_call_output|tool[_ ](?:output|result))\b/i.test(feature) && /\b(?:image|input_image)\b/i.test(feature) &&
    Array.isArray(params.input) && params.input.some(item => item.type === 'function_call_output' &&
      Array.isArray(item.output) && item.output.some(part => part.type === 'input_image'));
}

/** Portable tool images follow the complete result batch and retain call attribution. */
export function compatibleToolImageProjection() {
  const pending = new Set<string>();
  const observations: ResponseInputItem[] = [];
  return (items: ResponseInputItem[]): ResponseInputItem[] => {
    const projected = items.map((item): ResponseInputItem => {
      if (item.type === "function_call") pending.add(item.call_id);
      if (item.type !== "function_call_output") return item;
      if (item.call_id) pending.delete(item.call_id);
      if (!Array.isArray(item.output) || !item.output.some(part => part.type === "input_image")) return item;
      const images = item.output.filter(part => part.type === "input_image");
      observations.push({ type: "message", role: "user", content: [
        { type: "input_text", text: `[tool_image_observation data]\n${JSON.stringify({ source: "tool_output", call_id: item.call_id })}` },
        ...images.map(image => ({ type: "input_image" as const, image_url: image.image_url,
          file_id: image.file_id, detail: image.detail ?? "auto" })),
      ] });
      return { ...item, output: item.output.filter(part => part.type === "input_text").map(part => part.text).join("\n") };
    });
    return pending.size ? projected : [...projected, ...observations.splice(0)];
  };
}
