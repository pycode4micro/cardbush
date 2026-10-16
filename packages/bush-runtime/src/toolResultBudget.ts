/** One delivery budget for tool output, discovery and archive pages. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 16_000;

/** Find the largest prefix whose complete envelope fits. Minimal receipts may
 * exceed an exhausted budget so that continuation information is never lost. */
export function fitToolResultPrefix(length: number, maxChars: number, render: (length: number) => string): string {
  let lower = 0, upper = length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (render(middle).length <= maxChars) lower = middle;
    else upper = middle - 1;
  }
  return render(lower);
}

/** Page complete entries, reserving one entry plus continuation as the minimum
 * receipt. This guarantees progress even when sibling calls exhaust the budget.
 * A genuinely oversized single entry still belongs in the immutable archive. */
export function fitToolResultPage(length: number, maxChars: number, render: (length: number) => string): string | undefined {
  const full = render(length);
  if (full.length <= maxChars) return full;
  const first = render(Math.min(1, length));
  // Finishing a page removes its cursor. With a long query that can be smaller
  // than the first-entry receipt, and should not inflate the minimum reserve.
  const minimum = full.length < first.length ? full : first;
  if (minimum.length > DEFAULT_TOOL_RESULT_MAX_CHARS && minimum.length > maxChars) return undefined;
  if (minimum.length >= maxChars) return minimum;
  return fitToolResultPrefix(length, maxChars, render);
}
