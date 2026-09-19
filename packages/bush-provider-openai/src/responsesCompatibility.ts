import type { ResponseInputItem } from "openai/resources/responses/responses";

/** Policy observation, not a claim that every individual extension is unsupported. */
export const RESPONSES_COMPATIBILITY_CAPABILITY = "responses_compatibility";

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
