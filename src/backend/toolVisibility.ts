export const standardImageInputToolDefaultName = 'inject_image_input';

export function normalizeDisabledTools(values?: Iterable<string> | null) {
  if (!values) {
    return undefined;
  }
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result.length > 0 ? result : undefined;
}

export function applyDisabledToolsToMetadata(
  metadata: Record<string, unknown>,
  values?: Iterable<string> | null,
) {
  const disabledTools = normalizeDisabledTools(values);
  if (!disabledTools) {
    return;
  }
  metadata.disabled_tools = disabledTools;
  metadata.disabledTools = disabledTools;
}
