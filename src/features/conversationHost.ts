import { createContext } from 'react';
import type { CardbushAppPlugin, ChatToolExecution, PluginCommandSummary } from '../types';
import type { WorkspaceDirectoryPage } from '../../electron/workspaceFiles';

/** Explicit host services; absence keeps the existing desktop behavior. */
export interface ConversationHost {
  id: string;
  plugins: CardbushAppPlugin[];
  pluginCommands: PluginCommandSummary[];
  uploadFiles(files: File[]): Promise<Array<{ path: string; name: string; previewUrl?: string }>>;
  openFile(path: string): void;
  readFile?(path: string): Promise<{ name: string; blob: Blob }>;
  readDirectory?(input: { directoryPath?: string; offset?: number }): Promise<WorkspaceDirectoryPage>;
  toolDetails(sessionId: string, turnId: string): Promise<ChatToolExecution[]>;
}
export const ConversationHostContext = createContext<ConversationHost | undefined>(undefined);
