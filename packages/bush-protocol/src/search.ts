import { z } from 'zod';

export const DEFAULT_SEARCH_RESULT_LIMIT = 8;
export const MAX_SEARCH_RESULT_LIMIT = 50;
export const searchResultLimitSchema = z.number().int().min(1).max(MAX_SEARCH_RESULT_LIMIT);

// Stay independent of the user's setting so edits do not change tool schemas.
export const searchLimitParameter = {
  type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULT_LIMIT,
  description: `Maximum search results. Omit to use the default in plugin settings (initially ${DEFAULT_SEARCH_RESULT_LIMIT}).`,
};
