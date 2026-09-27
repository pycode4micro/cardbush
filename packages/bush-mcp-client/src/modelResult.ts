import { omitToolImageData } from '@cardbush/bush-runtime';
import { isDeepStrictEqual } from 'node:util';

/** Presentation only; native bytes and server status remain in the execution journal. */
export function projectMcpResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const { _meta, ...value } = result as Record<string, unknown>;
  if (value.structuredContent != null && Array.isArray(value.content)) {
    value.content = value.content.filter((block: unknown) => {
      if (!block || typeof block !== 'object') return true;
      const item = block as Record<string, unknown>;
      if (item.type !== 'text' || typeof item.text !== 'string') return true;
      // Standard MCP servers often include the same JSON for legacy clients.
      // Only remove exact semantic duplicates; prose, warnings and images stay.
      try { return !isDeepStrictEqual(JSON.parse(item.text), value.structuredContent); }
      catch { return true; }
    });
  }
  return JSON.stringify(omitToolImageData(value));
}
