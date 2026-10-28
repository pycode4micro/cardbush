import { uiText } from '../../i18n';
import { runtimeSolutionAnswerSchema, solutionSelectionQuestions, type RuntimeSolutionAnswer,
  type SolutionQuestionAnswer, type SolutionSelectionInput } from '@cardbush/bush-protocol';
import type { InteractionReplyAnswer, PendingInteraction } from '../../types';

export function solutionInteractionQuestions(input: SolutionSelectionInput) {
  return solutionSelectionQuestions(input).map(question => ({
    id: question.id, label: uiText()('solutionSelectionModel.solution_selection'), question: question.prompt,
    options: question.options.map((label, index) => ({ id: String(index), label })),
  }));
}

/** Desktop and web send one complete, identity-bound reply, never partial answers. */
export function solutionInteractionAnswer(interaction: PendingInteraction, replies: InteractionReplyAnswer[]): RuntimeSolutionAnswer {
  const questions = interaction.questions ?? [];
  if (!questions.length || replies.length !== questions.length
    || new Set(replies.map(reply => reply.questionId)).size !== questions.length
    || replies.some(reply => !questions.some(question => question.id === reply.questionId))) {
    throw new Error(uiText()('solutionSelectionModel.answer_every_requested_question_exactly_once'));
  }
  const answers: SolutionQuestionAnswer[] = questions.map(question => {
    const reply = replies.find(reply => reply.questionId === question.id)!;
    if ((reply.selectedOptionId !== undefined) === Boolean(reply.text?.trim())) {
      throw new Error(uiText()('solutionSelectionModel.choose_one_solution_or_write_your_own'));
    }
    if (reply.selectedOptionId !== undefined) {
      if (!question.options.some(option => option.id === reply.selectedOptionId) || !/^[0-2]$/.test(reply.selectedOptionId)) {
        throw new Error(uiText()('solutionSelectionModel.invalid_solution_option'));
      }
      return { questionId: question.id, kind: 'option', optionIndex: Number(reply.selectedOptionId) };
    }
    return { questionId: question.id, kind: 'text', text: reply.text!.trim() };
  });
  const identity = { selectionId: interaction.id, sessionId: interaction.sessionId!, turnId: interaction.turnId! };
  if (Array.isArray(interaction.raw.questions)) {
    return runtimeSolutionAnswerSchema.parse({ ...identity, kind: 'answers', answers });
  }
  if (answers.length !== 1) throw new Error(uiText()('solutionSelectionModel.a_legacy_selection_requires_one_answer'));
  const { questionId: _, ...answer } = answers[0];
  return runtimeSolutionAnswerSchema.parse({ ...identity, ...answer });
}
