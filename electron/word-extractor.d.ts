declare module 'word-extractor' {
  class ExtractedDocument {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
  }

  export default class WordExtractor {
    extract(filePath: string): Promise<ExtractedDocument>;
  }
}
