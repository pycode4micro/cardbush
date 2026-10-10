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
