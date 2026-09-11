/** Model privacy projection only; the server's result and status remain authoritative. */
export function projectMcpResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const { _meta, ...value } = result as Record<string, unknown>;
  return JSON.stringify(value);
}
