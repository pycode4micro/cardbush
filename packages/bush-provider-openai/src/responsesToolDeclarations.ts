import type { ResponseInputItem, Tool } from "openai/resources/responses/responses";

export interface ResponseInputGroup {
  messageIndex: number;
  items: ResponseInputItem[];
}

/** Deduplicate the wire view, never the persisted search results or call pairs. */
export function uniqueToolDeclarations(groups: ResponseInputGroup[], tools: Tool[] | undefined, offset: number) {
  const declared = new Map<string, { tool: Tool; signature: string; messageIndex: number }>();
  const omitted = new Set<Tool>();
  let replayFromStart = false;
  const remember = (tool: Tool, messageIndex: number) => {
    if (tool.type !== "function") return;
    const signature = canonical({ ...tool, defer_loading: undefined });
    const prior = declared.get(tool.name);
    if (prior) {
      if (messageIndex === -1 && prior.signature !== signature) {
        throw new Error(`Conflicting tool definitions for ${tool.name}.`);
      }
      // The current, explicitly exposed tools take precedence over discoveries.
      if (prior.messageIndex === -1 || prior.signature === signature) {
        omitted.add(tool);
        return;
      }
      // A changed definition belongs at its new discovery point. Replacing an
      // already-sent declaration requires a full replay, once for this update.
      omitted.add(prior.tool);
      if (prior.messageIndex < offset && messageIndex >= offset) replayFromStart = true;
    }
    declared.set(tool.name, { tool, signature, messageIndex });
  };
  for (const tool of tools ?? []) remember(tool, -1);
  for (const group of groups) {
    for (const item of group.items) {
      if (item.type === "tool_search_output" || item.type === "additional_tools") {
        for (const tool of item.tools) remember(tool, group.messageIndex);
      }
    }
  }
  return {
    replayFromStart,
    tools: tools?.filter(tool => !omitted.has(tool)),
    input: groups.flatMap(group => group.messageIndex < offset && !replayFromStart ? [] : group.items.flatMap((item): ResponseInputItem[] => {
      if (item.type !== "tool_search_output" && item.type !== "additional_tools") return [item];
      const unique = item.tools.filter(tool => !omitted.has(tool));
      // Even an empty search result must acknowledge its own call_id.
      return item.type === "additional_tools" && !unique.length ? [] : [{ ...item, tools: unique }];
    })),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
