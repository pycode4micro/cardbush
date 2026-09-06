type LogicRecord = Record<string, unknown>;
type TermStats = { frequencies: Map<string, number>; length: number };

// Standard BM25 parameters, independent of tasks, Tools, domains and memory rewards.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function textValues(values: unknown[]): string[] {
  return values.flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => String(value ?? ""));
}

function tokenize(text: string): TermStats {
  const frequencies = new Map<string, number>();
  let length = 0;
  // Stream message-sized segments rather than materializing the whole Session.
  for (const { isWordLike, segment } of segmenter.segment(text.normalize("NFKC").toLowerCase())) {
    if (isWordLike && [...segment].length > 1) {
      frequencies.set(segment, (frequencies.get(segment) ?? 0) + 1);
      length += 1;
    }
  }
  return { frequencies, length };
}

/** Caches tokenization, not search results. Retains only texts used by the latest search. */
export class LogicRetriever {
  #terms = new Map<string, TermStats>();

  clear(): void { this.#terms.clear(); }

  search(records: LogicRecord[], query: unknown[]) {
    const nextTerms = new Map<string, TermStats>();
    const stats = (text: string) => {
      const result = nextTerms.get(text) ?? this.#terms.get(text) ?? tokenize(text);
      nextTerms.set(text, result);
      return result;
    };
    const requestedTerms = new Set<string>();
    if (records.length) {
      for (const text of textValues(query)) {
        for (const term of stats(text).frequencies.keys()) requestedTerms.add(term);
      }
    }
    const documents = requestedTerms.size ? records.map(record => {
      const frequencies = new Map<string, number>();
      let length = 0;
      for (const text of textValues([record.scenario, record.conditions, record.cognitive_patterns,
        record.bias, record.correction ?? record.correction_logic ?? record.lesson,
        record.reflection_question ?? record.reflection_prompt, record.tags])) {
        const words = stats(text);
        length += words.length;
        for (const [term, count] of words.frequencies) frequencies.set(term, (frequencies.get(term) ?? 0) + count);
      }
      return { record, frequencies, length };
    }) : [];
    this.#terms = nextTerms;
    const documentFrequencies = new Map<string, number>();
    for (const document of documents) {
      for (const term of document.frequencies.keys()) {
        documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
      }
    }
    const averageLength = documents.reduce((sum, document) => sum + document.length, 0) /
      Math.max(1, documents.length) || 1;
    return documents.map(({ record, frequencies, length }) => {
      // Iterate the shorter document vocabulary, not the entire long Session query.
      const matchedTerms = [...frequencies.keys()].filter(term => requestedTerms.has(term));
      const score = matchedTerms.reduce((total, term) => {
        const frequency = frequencies.get(term)!;
        const documentFrequency = documentFrequencies.get(term)!;
        const idf = Math.log1p((documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        return total + idf * frequency * (BM25_K1 + 1) /
          (frequency + BM25_K1 * (1 - BM25_B + BM25_B * length / averageLength));
      }, 0);
      return { record, score, matchedTerms };
    }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score);
  }
}

/** Lexical retrieval only: no semantic classes, hand-written keyword lists or quality labels. */
export function retrieveLogic(records: LogicRecord[], query: unknown[]) {
  return new LogicRetriever().search(records, query);
}
