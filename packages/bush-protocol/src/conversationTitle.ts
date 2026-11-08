export const conversationTitleLimit = 20;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Bound an automatic title without cutting a user-perceived character. */
export function compactConversationTitle(text: string): string {
  const characters: string[] = [];
  for (const { segment } of graphemes.segment(text.trim().replace(/\s+/gu, ' '))) {
    if (characters.length === conversationTitleLimit) return characters.slice(0, -1).join('').trimEnd() + '…';
    characters.push(segment);
  }
  return characters.join('');
}
