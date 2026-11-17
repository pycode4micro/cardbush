import { z } from 'zod';

/** Transport observations only; no platform credentials or model instructions. */
export const bridgeDeliveryResultSchema = z.object({
  deliveryId: z.string().uuid(), status: z.enum(['delivered', 'failed']), deliveryConfirmed: z.boolean(),
  textPartsSent: z.number().int().nonnegative(), filesSent: z.number().int().nonnegative(),
  phase: z.string().regex(/^[a-z_]{1,40}$/).optional(), attempts: z.number().int().nonnegative().optional(),
  createdAt: z.number().nonnegative().optional(), startedAt: z.number().nonnegative().optional(),
  updatedAt: z.number().nonnegative().optional(), completedAt: z.number().nonnegative().optional(),
  lastError: z.object({ code: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/), at: z.number().nonnegative(), phase: z.string().regex(/^[a-z_]{1,40}$/),
    details: z.object({ operation: z.string().regex(/^[a-z_]{1,40}$/).optional(), httpStatus: z.number().int().optional(),
      ret: z.number().int().optional(), errcode: z.number().int().optional(), message: z.string().max(512).optional() }).strict().optional(),
  }).strict().optional(),
  timings: z.object({ queueMs: z.number().nonnegative(), uploadMs: z.number().nonnegative(), sendMs: z.number().nonnegative() }).strict().optional(),
}).strict().refine(value => value.deliveryConfirmed === (value.status === 'delivered'));
