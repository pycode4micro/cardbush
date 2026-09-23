import { createContext } from 'react';
import type { ConversationRuntime } from '../backend/conversationRuntime';
import type { WorkSummaryInspectorDetail } from './subagents/subagentObservabilityEvents';
import type { CardbushAppPlugin, ChatToolExecution, PluginCommandSummary } from '../types';
import type { WorkspaceDirectoryPage } from '../../electron/workspaceFiles';

/** Explicit host services; absence keeps the existing desktop behavior. */
export interface ConversationHost {
  id: string;
  sessionId?: string;
  runtime?: ConversationRuntime;
  openWorkSummary?(detail: WorkSummaryInspectorDetail): void;
  plugins: CardbushAppPlugin[];
  pluginCommands: PluginCommandSummary[];
  uploadFiles(files: File[]): Promise<Array<{ path: string; name: string; previewUrl?: string }>>;
  openFile(path: string): void;
  openExtract?(id: string): void;
  readFile?(path: string): Promise<{ name: string; blob: Blob }>;
  previewFile?(path: string): Promise<{ source: string; dispose(): void }>;
  readDirectory?(input: { directoryPath?: string; offset?: number }): Promise<WorkspaceDirectoryPage>;
  toolDetails(sessionId: string, turnId: string): Promise<ChatToolExecution[]>;
}
export const ConversationHostContext = createContext<ConversationHost | undefined>(undefined);
