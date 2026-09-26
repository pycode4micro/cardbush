/** Tool-owned text presentation. Metadata is structured; text is never JSON-quoted. */
export function renderTextFields(result: unknown, fields: readonly string[]): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = result as Record<string, unknown>;
  const texts = fields.filter((field) => typeof value[field] === "string");
  if (!texts.length) return undefined;
  const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => !texts.includes(key)));
  return [
    JSON.stringify(metadata),
    ...texts.map((field) => `[${field}]\n${value[field] as string}`),
  ].join("\n\n");
}

/** A returned terminal receipt is not proof that the command achieved its goal. */
export function renderTerminalResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const value = result as Record<string, unknown>;
  const nonzero = typeof value.exitCode === 'number' && value.exitCode !== 0;
  const failed = value.state === 'failed' || nonzero;
  const diagnostics = typeof value.stderr === 'string' && value.stderr.trim().length > 0;
  const notice = failed
    ? 'The terminal tool returned, but the command failed. Inspect exitCode, error and output; verify partial effects before retrying.'
    : diagnostics
      ? 'stderr contains diagnostic output, which may include warnings or non-terminating errors even with exitCode 0. Inspect it and verify the requested output before claiming success; do not repeat completed side effects.'
      : undefined;
  return renderTextFields(notice ? { ...value, runtime_notice: notice } : value, ['stdout', 'stderr']);
}
