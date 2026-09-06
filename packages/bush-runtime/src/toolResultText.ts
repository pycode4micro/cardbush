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
