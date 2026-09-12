import type { ChildTurnRunner, SubagentPermissionPolicy } from './childTurn.js';
import type { SubagentTaskStore } from './subagentTaskStore.js';
import type { ToolRegistry } from './toolRegistry.js';

/** Versioned API for installed, trusted native plugins. It is not a sandbox. */
export interface RuntimeExtensionApi {
  tools: ToolRegistry;
  dataDirectory?: string;
  getToolDefinitions: () => ReturnType<ToolRegistry['definitions']>;
  subagentTasks: SubagentTaskStore;
  runChild: ChildTurnRunner;
  hasActiveTurns: () => boolean;
  permissionPolicy: SubagentPermissionPolicy;
}

export interface RuntimeExtension {
  id: string;
  features: string[];
  commands: Record<string, (payload: unknown, signal?: AbortSignal) => unknown | Promise<unknown>>;
  dispose?: () => void;
}

export type RuntimeExtensionFactory = (api: RuntimeExtensionApi) => RuntimeExtension;

export function runtimeExtensionOwner(id: string): string { return `extension:${id}`; }
