import { renderPromptTemplate } from '@cardbush/platform/prompts';
/** Shared by product turns and clean/fork child assignments, including continuations. */
export const REPORT_DELIVERY_INSTRUCTIONS = renderPromptTemplate('report-delivery-instructions');

export const TASK_CONTINUATION_INSTRUCTIONS = renderPromptTemplate('task-continuation-instructions');

export const SOURCE_BINDING_INSTRUCTIONS = renderPromptTemplate('source-binding-instructions');
