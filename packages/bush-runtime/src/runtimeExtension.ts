import type { ChildTurnRunner, SubagentPermissionPolicy } from './childTurn.js';
import type { SubagentTaskStore } from './subagentTaskStore.js';
import type { ToolRegistry } from './toolRegistry.js';
import type { ModelMessage } from '@cardbush/bush-protocol';
import type { RuntimeConversation, RuntimeConversationsApi } from './runtimeConversations.js';

/** Versioned API for installed, trusted native plugins. It is not a sandbox. */
export interface RuntimeExtensionApi {
  tools: ToolRegistry;
  dataDirectory?: string;
  getToolDefinitions: () => ReturnType<ToolRegistry['definitions']>;
  subagentTasks: SubagentTaskStore;
  runChild: ChildTurnRunner;
  hasActiveTurns: () => boolean;
  permissionPolicy: SubagentPermissionPolicy;
  conversations: RuntimeConversationsApi;
}

export interface RuntimeExtension {
  id: string;
  features: string[];
  commands: Record<string, (payload: unknown, signal?: AbortSignal) => unknown | Promise<unknown>>;
  dispose?: () => void | Promise<void>;
  /** Appended user context; never rewrites the stable system prefix. */
  conversationContext?: (conversation: RuntimeConversation) => Promise<ModelMessage[]>;
  conversationChanged?: (conversation: RuntimeConversation) => void | Promise<void>;
}

export type RuntimeExtensionFactory = (api: RuntimeExtensionApi) => RuntimeExtension;

export function runtimeExtensionOwner(id: string): string { return `extension:${id}`; }
