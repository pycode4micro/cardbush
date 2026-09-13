import { z } from 'zod';

export const SOLUTION_SELECTION_TOOL = 'solution_selection' as const;
export const LIST_RUNTIME_SOLUTION_SELECTIONS_COMMAND = 'runtime.list_solution_selections' as const;
export const ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND = 'runtime.answer_solution_selection' as const;

// Count Unicode characters rather than UTF-16 units; never truncate a decision.
const briefText = z.string().trim().min(1).refine(value => Array.from(value).length <= 15,
  'Use at most 15 characters.').refine(value => !/[\r\n]/u.test(value), 'Use one line of plain text.');
export const solutionSelectionInputSchema = z.object({
  prompt: briefText,
  options: z.array(briefText).min(1).max(3).refine(options => new Set(options).size === options.length,
    'Offer distinct solutions.'),
}).strict();

export const runtimeSolutionSelectionSchema = z.object({
  selectionId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  createdAt: z.string().min(1),
  ...solutionSelectionInputSchema.shape,
});
const answerIdentity = z.object({
  selectionId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});
export const runtimeSolutionAnswerSchema = z.discriminatedUnion('kind', [
  answerIdentity.extend({ kind: z.literal('option'), optionIndex: z.number().int().min(0).max(2) }).strict(),
  answerIdentity.extend({ kind: z.literal('text'), text: z.string().trim().min(1).max(8000) }).strict(),
  answerIdentity.extend({ kind: z.literal('cancel') }).strict(),
]);
export type SolutionSelectionInput = z.infer<typeof solutionSelectionInputSchema>;
export type RuntimeSolutionSelection = z.infer<typeof runtimeSolutionSelectionSchema>;
export type RuntimeSolutionAnswer = z.infer<typeof runtimeSolutionAnswerSchema>;
