/** Shared multilingual ranking for installed Skills and package metadata. */
export function rankPluginText(query: string) {
  const needle = normalize(query), terms = tokens(query);
  return (id: string, text: string) => {
    if (needle === '*') return 1;
    const name = normalize(id), description = normalize(text);
    if (name === needle) return Number.MAX_SAFE_INTEGER;
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += name === term ? 4 : 2;
      else if (description.includes(term)) score++;
    }
    // On equal coverage, a focused description outranks a long catalog overview.
    return score ? score + 1 / (description.length + 2) : 0;
  };
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function tokens(value: string) {
  // Whitespace splitting treats a Chinese request as one unmatchable term. Keep
  // identifiers intact, but segment unspaced text. ICU can split unknown terms
  // such as 插件 into single characters; pairs preserve recall without matching
  // every description on a particle such as 的.
  return [...new Set(normalize(value).split(/[^\p{L}\p{N}_]+/u).flatMap((part) =>
    /\p{Script=Han}/u.test(part)
      ? segmentHanText(part)
      : part ? [part] : [],
  ))];
}

function segmentHanText(value: string): string[] {
  const result = [...value].length > 1 ? [value] : [];
  let previousHan = "";
  for (const item of wordSegmenter.segment(value)) {
    if (/^\p{Script=Han}$/u.test(item.segment)) {
      if (previousHan) result.push(previousHan + item.segment);
      previousHan = item.segment;
    } else {
      previousHan = "";
      if (item.isWordLike) result.push(item.segment);
    }
  }
  return result;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}
