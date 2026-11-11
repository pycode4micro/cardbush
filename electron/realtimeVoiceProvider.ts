import { renderPromptTemplate } from '@cardbush/platform/prompts';
import type { RealtimeToolResult, RealtimeVoiceEvent, RealtimeVoiceSettings } from './realtimeVoiceTypes';
import { assistantPageTool, conversationalSubagentTools } from '@cardbush/bush-protocol/conversational-subagent-tools';

export type ProviderEvent = RealtimeVoiceEvent extends infer E ? E extends { id: string } ? Omit<E, 'id'> : never : never;
export type RealtimeWireEvent = Record<string, unknown>;
export type RealtimeWireEvents = RealtimeWireEvent | RealtimeWireEvent[];
export type RealtimeHistoryItem = { id?: string; role: 'user' | 'assistant'; text: string };
export interface RealtimeVoiceProvider {
  /** Mutable protocol state belongs to one socket, including after reconnect. */
  createConnection?(language: () => string): RealtimeVoiceProvider;
  endpoint: string | ((settings: RealtimeVoiceSettings) => string);
  serverInitiatedSession?: boolean;
  /** Whether this connection accepts an explicit model turn before any live input. */
  supportsOpening?(ready: RealtimeWireEvent): boolean;
  closeWithSocket?: boolean;
  archiveOnResponseDone?: boolean;
  /** Providers without item restore/delete use an acknowledged instructions snapshot. */
  contextMode?: 'instructions';
  /** This provider replaces client event/item IDs in context receipts. */
  serverAssignedContextIds?: boolean;
  contextPolicy?: { maintenanceTokens: number; maxInputBytes: number; batchItems: number; maxPairs?: number };
  /** Convert vendor events to the canonical conversation lifecycle/ACK protocol. */
  normalize?(event: RealtimeWireEvent): RealtimeWireEvents;
  /** Translate canonical maintenance requests too (retrieve/delete/restore). */
  encode?(event: RealtimeWireEvent): RealtimeWireEvents;
  headers(key: string): Record<string, string>;
  start(settings: RealtimeVoiceSettings, voice: string, assistant?: { name: string; persona: string }, context?: RealtimeHistoryItem[]): object;
  updateVoice?(voice: string): object;
  /** Narrow updates when the native protocol permits instructions-only changes. */
  updateInstructions?(session: object): object;
  context(items: { id?: string; role: 'user' | 'assistant'; text: string }[]): object;
  audio(pcm: string): object;
  control(action: 'mute' | 'unmute' | 'interrupt' | 'commit' | 'close'): object;
  results(results: RealtimeToolResult[]): object;
  speak(text: string): object;
  parse(event: Record<string, unknown>): ProviderEvent[];
}
const hangUp = { type: 'function', name: 'hang_up', description: 'End this voice call when the user asks to hang up or clearly says goodbye. Say a brief goodbye before calling. Does not stop background Agent tasks.',
  parameters: { type: 'object', additionalProperties: false, properties: {} } };
const recallConversation = { type: 'function', name: 'recall_conversation', description: 'Read saved conversation history for this call when the user refers to earlier exchanges. Returns actual records, including earlier calls and text input; never invent missing memories.',
  parameters: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'integer', minimum: 0, description: 'Omit for the first page; use nextCursor to continue reading.' } } } };
export const realtimeAgentTools = [...conversationalSubagentTools.map(({ name, description, inputSchema }) => ({
  type: 'function', name, description, parameters: inputSchema,
})), hangUp, recallConversation];
export const realtimeExecutionInstructions = renderPromptTemplate('realtime-execution-instructions', {
  reportConversationPolicy: renderPromptTemplate('report-conversation-policy'),
});

export function realtimeConversationInstructions(settings: Pick<RealtimeVoiceSettings, 'instructions'>): string {
  return settings.instructions.trim() ? settings.instructions : renderPromptTemplate('realtime-default-instructions');
}

const pageWrite = { type: 'function', name: assistantPageTool.name, description: assistantPageTool.description, parameters: assistantPageTool.inputSchema };
export function realtimeConversationStyle(settings: RealtimeVoiceSettings, assistant?: { name: string; persona: string }) {
  const persona = assistant ? renderPromptTemplate('realtime-assistant-persona', { name: assistant.name,
    persona: assistant.persona.trim() ? assistant.persona : renderPromptTemplate('assistant-default-persona') }) : '';
  return [persona, realtimeConversationInstructions(settings)].filter(Boolean).join('\n\n');
}
export function realtimeSessionContent(settings: RealtimeVoiceSettings, assistant?: { name: string; persona: string }) {
  return { instructions: realtimeConversationStyle(settings, assistant) + '\n\n' + realtimeExecutionInstructions,
    tools: assistant ? [...realtimeAgentTools, pageWrite] : realtimeAgentTools };
}
