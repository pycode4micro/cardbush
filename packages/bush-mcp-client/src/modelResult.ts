import { omitToolImageData } from '@cardbush/bush-runtime';

/** Presentation only; native bytes and server status remain in the execution journal. */
export function projectMcpResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const { _meta, ...value } = result as Record<string, unknown>;
  return JSON.stringify(omitToolImageData(value));
}
