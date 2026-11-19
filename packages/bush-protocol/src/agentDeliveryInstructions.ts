import { renderPromptTemplate } from '@cardbush/platform/prompts';
/** Shared by product turns and clean/fork child assignments, including continuations. */
export const REPORT_DELIVERY_INSTRUCTIONS = renderPromptTemplate('report-delivery-instructions', {
  reportConversationPolicy: renderPromptTemplate('report-conversation-policy'),
});

const reportDeliveryPreface = REPORT_DELIVERY_INSTRUCTIONS + '\n\n';

/** Remove the known CardBush transport preface, leaving the task text verbatim. */
export function withoutReportDeliveryPreface(text: string): string {
  return text.startsWith(reportDeliveryPreface) ? text.slice(reportDeliveryPreface.length) : text;
}

export const OUTCOME_VERIFICATION_INSTRUCTIONS = renderPromptTemplate('outcome-verification');
export const OUTCOME_VERIFICATION_MESSAGE = {
  role: 'developer' as const, name: 'outcome_verification', content: OUTCOME_VERIFICATION_INSTRUCTIONS,
};

export const TASK_CONTINUATION_INSTRUCTIONS = renderPromptTemplate('task-continuation-instructions');

export const SOURCE_BINDING_INSTRUCTIONS = renderPromptTemplate('source-binding-instructions');
