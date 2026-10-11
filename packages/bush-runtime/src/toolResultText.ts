import { terminalCommandOutcome } from '@cardbush/bush-protocol';

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
  const failed = terminalCommandOutcome(value) === 'failed';
  const diagnostics = typeof value.stderr === 'string' && value.stderr.trim().length > 0;
  const notice = failed
    ? 'The terminal tool returned, but the command failed. Inspect exitCode, error and output; verify partial effects before retrying.'
    : diagnostics
      ? 'stderr contains diagnostic output, which may include warnings or non-terminating errors even with exitCode 0. Inspect it and verify the requested output before claiming success; do not repeat completed side effects.'
      : undefined;
  return renderTextFields(notice ? { ...value, runtime_notice: notice } : value, ['stdout', 'stderr']);
}

/** Preserve process status and diagnostic tails under the final shared ingress
 * budget, including completion notifications. Full native output stays archived. */
export function projectTerminalResult(result: unknown, maxChars: number): string | undefined {
  const full = renderTerminalResult(result);
  if (full === undefined || full.length <= maxChars) return full;
  const value = result as Record<string, unknown>;
  const essentials = Object.fromEntries(['terminalSessionId', 'state', 'exitCode', 'signal'].flatMap(key => {
    const item = value[key];
    return item === null || typeof item === 'number' || typeof item === 'string'
      ? [[key, typeof item === 'string' ? item.slice(0, 160) : item]] : [];
  }));
  const failed = terminalCommandOutcome(value) === 'failed';
  const minimum = JSON.stringify({ ...essentials, ...(failed ? { runtime_notice: 'The command failed; inspect diagnostics before retrying.' } : {}) });
  if (maxChars <= minimum.length) return minimum;
  const fields = ['error', 'stderr', 'stdout'].filter(key => typeof value[key] === 'string' && (value[key] as string).length > 0);
  const fullMetadata = JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key))));
  const metadata = fullMetadata.length <= Math.floor(maxChars / 3)
    ? JSON.stringify({ ...JSON.parse(fullMetadata), ...(failed ? { runtime_notice: 'The command failed; inspect diagnostics before retrying.' } : {}) })
    : minimum;
  let available = Math.max(0, maxChars - metadata.length - fields.reduce((sum, key) => sum + key.length + 5, 0));
  const sections: string[] = [];
  for (const [index, key] of fields.entries()) {
    const text = value[key] as string;
    // Give diagnostics first claim on space, leaving room for stdout's tail.
    const budget = index === fields.length - 1 ? available : Math.min(text.length, Math.floor(available * 0.6));
    const excerpt = terminalExcerpt(text, budget, key === 'stdout' ? 0.5 : 0.2);
    available -= excerpt.length;
    sections.push(`[${key}]\n${excerpt}`);
  }
  const preview = [metadata, ...sections].join('\n\n');
  return preview.length <= maxChars ? preview : minimum;
}

function terminalExcerpt(text: string, budget: number, headShare: number): string {
  if (text.length <= budget) return text;
  const omitted = '\n[… omitted; see archive …]\n';
  if (budget <= omitted.length) return budget >= 3 ? '[…]' : '';
  const headChars = Math.floor((budget - omitted.length) * headShare);
  const tailChars = budget - omitted.length - headChars;
  // Do not split a UTF-16 surrogate pair in either excerpt.
  const head = text.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, '');
  const tail = text.slice(-tailChars).replace(/^[\uDC00-\uDFFF]/, '');
  return head + omitted + tail;
}
