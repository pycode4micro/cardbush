import { z } from 'zod';

const coordinate = z.number().int().min(0).max(8191);
export const desktopInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), x: coordinate, y: coordinate, button: z.enum(['left', 'right', 'middle']).optional() }).strict(),
  z.object({ action: z.literal('drag'), x: coordinate, y: coordinate, toX: coordinate, toY: coordinate }).strict(),
  z.object({ action: z.literal('scroll'), x: coordinate, y: coordinate, direction: z.enum(['up', 'down']), steps: z.number().int().min(1).max(10).optional() }).strict(),
  z.object({ action: z.literal('key'), key: z.string().min(1).max(80).regex(/^[A-Za-z0-9_+]+$/) }).strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(16000) }).strict(),
]);
export const computerActionSchema = z.object({
  action: z.enum(['observe', 'click', 'drag', 'scroll', 'key', 'type']),
  stateId: z.string().uuid().optional(),
  x: coordinate.optional(), y: coordinate.optional(), toX: coordinate.optional(), toY: coordinate.optional(),
  button: z.enum(['left', 'right', 'middle']).optional(), direction: z.enum(['up', 'down']).optional(),
  steps: z.number().int().min(1).max(10).optional(), key: z.string().max(80).optional(), text: z.string().max(16000).optional(),
}).strict();
export const browserActionSchema = z.object({
  action: z.enum(['tabs', 'open', 'navigate', 'snapshot', 'screenshot', 'click', 'fill', 'key', 'scroll', 'close']),
  tabId: z.string().uuid().optional(), stateId: z.string().uuid().optional(),
  url: z.string().max(8192).optional(), element: z.number().int().min(0).max(199).optional(),
  text: z.string().max(16000).optional(), key: z.string().max(80).optional(),
  direction: z.enum(['up', 'down']).optional(),
}).strict().superRefine((value, context) => {
  const required: Array<keyof typeof value> = [];
  if (!['tabs', 'open'].includes(value.action)) required.push('tabId');
  if (['open', 'navigate'].includes(value.action)) required.push('url');
  if (['click', 'fill'].includes(value.action)) required.push('element');
  if (value.action === 'fill') required.push('text');
  if (value.action === 'key') required.push('key');
  if (value.action === 'scroll') required.push('direction');
  for (const key of required) if (value[key] === undefined) context.addIssue({ code: 'custom', path: [key], message: `${key} is required for ${value.action}.` });
});
export const desktopToolRequestSchema = z.object({
  sessionId: z.string().min(1).max(160), turnId: z.string().min(1).max(160),
  tool: z.enum(['computer', 'browser']), input: z.unknown(),
}).strict();
