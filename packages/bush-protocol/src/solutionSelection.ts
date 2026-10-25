import { z } from 'zod';

export const LIST_RUNTIME_SOLUTION_SELECTIONS_COMMAND = 'runtime.list_solution_selections' as const;
export const ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND = 'runtime.answer_solution_selection' as const;

// Count Unicode characters rather than UTF-16 units; never truncate a decision.
const briefText = (limit: number) => z.string().trim().min(1).refine(value => Array.from(value).length <= limit,
  `Use at most ${limit} characters.`).refine(value => !/[\r\n]/u.test(value), 'Use one line of plain text.');
const questionFields = {
  prompt: briefText(500),
  options: z.array(briefText(120)).min(1).max(3).refine(options => new Set(options).size === options.length,
    'Offer distinct solutions.'),
};
export const solutionQuestionSchema = z.object({ id: briefText(80), ...questionFields }).strict();
const selectionFields = {
  // Keep the original single-question wire format for existing tools and sessions.
  prompt: questionFields.prompt.optional(),
  options: questionFields.options.optional(),
  questions: z.array(solutionQuestionSchema).min(1).max(3)
    .refine(questions => new Set(questions.map(question => question.id)).size === questions.length,
      'Question IDs must be unique.').optional(),
};
const validSelection = (input: { prompt?: string; options?: string[]; questions?: unknown[] }) =>
  input.questions !== undefined ? input.prompt === undefined && input.options === undefined
    : input.prompt !== undefined && input.options !== undefined;
export const solutionSelectionInputSchema = z.object(selectionFields).strict()
  .refine(validSelection, 'Provide either questions or the single-question prompt and options, not both.');

export const runtimeSolutionSelectionSchema = z.object({
  selectionId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  createdAt: z.string().min(1),
  blocking: z.boolean().optional(),
  ...selectionFields,
}).refine(validSelection, 'Provide either questions or the single-question prompt and options, not both.');
const answerIdentity = z.object({
  selectionId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});
export const solutionQuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ questionId: briefText(80), kind: z.literal('option'), optionIndex: z.number().int().min(0).max(2) }).strict(),
  z.object({ questionId: briefText(80), kind: z.literal('text'), text: z.string().trim().min(1).max(8000) }).strict(),
]);
export const runtimeSolutionAnswerSchema = z.discriminatedUnion('kind', [
  answerIdentity.extend({ kind: z.literal('option'), optionIndex: z.number().int().min(0).max(2) }).strict(),
  answerIdentity.extend({ kind: z.literal('text'), text: z.string().trim().min(1).max(8000) }).strict(),
  answerIdentity.extend({ kind: z.literal('answers'), answers: z.array(solutionQuestionAnswerSchema).min(1).max(3)
    .refine(answers => new Set(answers.map(answer => answer.questionId)).size === answers.length,
      'Answer each question exactly once.') }).strict(),
  answerIdentity.extend({ kind: z.literal('cancel') }).strict(),
]);
export type SolutionQuestion = z.infer<typeof solutionQuestionSchema>;
export type SolutionQuestionAnswer = z.infer<typeof solutionQuestionAnswerSchema>;
export type SolutionSelectionInput = z.infer<typeof solutionSelectionInputSchema>;
export type RuntimeSolutionSelection = z.infer<typeof runtimeSolutionSelectionSchema>;
export type RuntimeSolutionAnswer = z.infer<typeof runtimeSolutionAnswerSchema>;

/** One normalized view for the runtime, desktop, web and native terminal. */
export function solutionSelectionQuestions(input: SolutionSelectionInput): SolutionQuestion[] {
  return input.questions ?? [{ id: 'solution', prompt: input.prompt!, options: input.options! }];
}
