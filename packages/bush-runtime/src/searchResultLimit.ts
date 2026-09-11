import { DEFAULT_SEARCH_RESULT_LIMIT, searchResultLimitSchema } from '@cardbush/bush-protocol';

export type SearchResultLimitProvider = () => number | Promise<number>;

export async function resolveSearchResultLimit(limit?: number, defaults?: SearchResultLimitProvider): Promise<number> {
  return searchResultLimitSchema.parse(limit ?? (defaults ? await defaults() : DEFAULT_SEARCH_RESULT_LIMIT));
}
