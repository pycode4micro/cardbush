export const pastedTextCharacterThreshold = 8_000;
export const pastedTextLineThreshold = 200;

/** Count without splitting a large paste into thousands of retained strings. */
export function pastedTextSummary(text: string) {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 13) { lines++; if (text.charCodeAt(i + 1) === 10) i++; }
    else if (text.charCodeAt(i) === 10) lines++;
  }
  // Copy the short preview: a V8 sliced string can otherwise retain the entire paste.
  const preview = [...text.slice(0, 160)].join('').replace(/\s+/g, ' ').trim();
  return { lines, preview, attach: text.length > pastedTextCharacterThreshold || lines > pastedTextLineThreshold };
}
