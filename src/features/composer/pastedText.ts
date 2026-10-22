export const pastedTextCharacterThreshold = 8_000;
export const pastedTextLineThreshold = 200;

/** Count without splitting a large paste into thousands of retained strings. */
function textLines(text: string) {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 13) { lines++; if (text.charCodeAt(i + 1) === 10) i++; }
    else if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export function pastedTextSummary(text: string, draft?: { value: string; start: number; end: number }) {
  const lines = textLines(text);
  let attach = text.length > pastedTextCharacterThreshold || lines > pastedTextLineThreshold;
  if (text && !attach && draft) {
    const start = Math.max(0, Math.min(draft.start, draft.end, draft.value.length));
    const end = Math.max(start, Math.min(Math.max(draft.start, draft.end), draft.value.length));
    // Check size before constructing the projected value: it is at most 8,000
    // characters. Keep the existing draft; only the incoming paste is attached.
    attach = draft.value.length - (end - start) + text.length > pastedTextCharacterThreshold
      || textLines(draft.value.slice(0, start) + text + draft.value.slice(end)) > pastedTextLineThreshold;
  }
  // Copy the short preview: a V8 sliced string can otherwise retain the entire paste.
  const preview = [...text.slice(0, 160)].join('').replace(/\s+/g, ' ').trim();
  return { lines, preview, attach };
}
