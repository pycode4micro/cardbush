type IntlSegmenter = {
  segment: (value: string) => Iterable<{ segment: string }>;
};

type IntlSegmenterConstructor = new (
  locale?: string,
  options?: { granularity?: 'grapheme' },
) => IntlSegmenter;

export function textGraphemes(value: string) {
  const Segmenter = (Intl as unknown as { Segmenter?: IntlSegmenterConstructor }).Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
      (item) => item.segment,
    );
  }
  return Array.from(value);
}

export function textLength(value: string) {
  return textGraphemes(value).length;
}

export function truncateText(value: string, maxLength: number, suffix = '...') {
  const graphemes = textGraphemes(value);
  if (graphemes.length <= maxLength) {
    return value;
  }
  const suffixLength = textLength(suffix);
  const keep = Math.max(0, maxLength - suffixLength);
  return `${graphemes.slice(0, keep).join('')}${suffix}`;
}
