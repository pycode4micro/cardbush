import { z } from 'zod';

export const EXTRACT_RUNTIME_SESSION_COMMAND = 'runtime.extract_session' as const;
export const FORK_RUNTIME_SESSION_COMMAND = 'runtime.fork_session' as const;
export const sessionExtractionRequestSchema = z.object({
  sessionId: z.string().min(1),
  keys: z.array(z.string().min(1)).max(10000).optional(),
});
export const forkRuntimeSessionRequestSchema = z.object({
  sourceSessionId: z.string().min(1), sessionId: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export interface ConversationExtractUnit {
  key: string; turnId: string; role: 'user' | 'assistant'; messageIds: string[];
  createdAt: string; text: string; summarized: boolean;
}
export interface ConversationExtractSource {
  sessionId: string; revision: number; title: string; units: ConversationExtractUnit[];
  defaultKeys: string[];
}
export interface ConversationExtractSelection {
  sessionId: string; keys: string[]; title: string; description: string;
  contextWindowTokens: number;
}
export interface ConversationExtractItem {
  id: string; sessionId: string; title: string; description: string;
  kind: 'temporary' | 'permanent' | 'reference'; createdAt: number; expiresAt?: number;
}
export interface ConversationExtractPreview {
  source: Omit<ConversationExtractSource, 'units'> & {
    units: Array<Omit<ConversationExtractUnit, 'text'> & { preview: string; tokens: number }>;
  };
  tokenLimit: number; overheadTokens: number; tokenMethod: string;
}
export interface ConversationExtractResolved { id: string; title: string; path: string; tokens: number; }
export interface ConversationExtractDesktopApi {
  preview(input: ConversationExtractSelection): Promise<ConversationExtractPreview>;
  list(): Promise<{ permanent: ConversationExtractItem[]; pending: ConversationExtractItem[] }>;
  save(input: ConversationExtractSelection, kind: ConversationExtractItem['kind']): Promise<ConversationExtractItem>;
  consume(id: string): Promise<ConversationExtractItem>;
  resolve(id: string, contextWindowTokens?: number): Promise<ConversationExtractResolved>;
  export(input: ConversationExtractSelection): Promise<{ cancelled?: boolean; path?: string; tokens?: number }>;
  remove(id: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}
