import { z } from 'zod';

export const toolScriptInputSchema = z.object({
  code: z.string().min(1).max(64000).describe('JavaScript async body that calls registered tools and returns useful JSON.'),
}).strict();
