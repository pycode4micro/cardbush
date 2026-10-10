import { fitToolResultPrefix } from './toolResultBudget.js';
import { renderTextFields } from './toolResultText.js';

/** Keep pagination truthful after the final (possibly shared) ingress budget.
 * A page always continues the original archive, never an archive of a page. */
export function projectArchivedToolResult(text: string, maxChars: number): string | undefined {
  let page: any;
  try { page = JSON.parse(text); } catch { return undefined; }
  if (!page || typeof page.locator !== 'string' || typeof page.complete !== 'boolean' || !Number.isSafeInteger(page.next_offset)) return undefined;
  if (typeof page.text === 'string' && Number.isSafeInteger(page.offset)) {
    const render = (size: number) => {
      // Never split a Unicode surrogate pair at a generated page boundary.
      if (size > 0 && size < page.text.length && /[\uD800-\uDBFF]/.test(page.text[size - 1])) size--;
      return renderTextFields({ ...page, text: page.text.slice(0, size),
        next_offset: page.offset + size, complete: page.complete && size === page.text.length }, ['text'])!;
    };
    return fitToolResultPrefix(page.text.length, maxChars, render);
  }
  if (typeof page.query === 'string' && Array.isArray(page.matches)) {
    // Whole search hits retain their offsets and quoted evidence. The first
    // omitted hit is the next page, including when the budget admits no hits.
    return fitToolResultPrefix(page.matches.length, maxChars, size => JSON.stringify({ ...page,
      matches: page.matches.slice(0, size),
      next_offset: size < page.matches.length ? page.matches[size].offset : page.next_offset,
      complete: page.complete && size === page.matches.length }));
  }
  return undefined;
}
